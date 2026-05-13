package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

type RTCClient struct {
	ServerID             string
	ChannelID            string
	UserID               string
	SessionID            string
	Token                string
	Protocol             string
	AudioSSRC            uint32
	VideoSSRC            uint32
	lastPLITime			 time.Time
	RtxAudioSSRC         uint32 //when the SFU detects a sequence number jump, assign this to the last ssrc
	RtxVideoSSRC         uint32
	Video                bool
	SelfMute             bool
	SelfDeaf             bool
	masterWebRTCAudio    *MultiplexTrack
	masterWebRTCVideo    *MultiplexTrack
	Socket               *websocket.Conn
	udpSocket            *net.UDPConn
	mu                   sync.Mutex
	pc                   *webrtc.PeerConnection
	udpAddr              *net.UDPAddr
	audioWebRTCPublished *PublishedWebRTCTrack
	videoWebRTCPublished *PublishedWebRTCTrack
	subscriptions        map[string]bool
	recorder             *oggwriter.OggWriter // Keep the writer alive here
	recorderMutex        sync.Mutex
	writeMu              sync.Mutex
}

type PublishedWebRTCTrack struct {
	track *webrtc.TrackLocalStaticRTP
	ssrc  webrtc.SSRC
	stop  chan struct{}
}

func NewRTCClient(userID string, serverID string, channelID string, sessionId string, token string, audio_ssrc uint32, video_ssrc uint32, video bool, socket *websocket.Conn) *RTCClient {
	return &RTCClient{
		ServerID:     serverID,
		UserID:       userID,
		SessionID:    sessionId,
		ChannelID:    channelID,
		Token:        token,
		Video:        video,
		Socket:       socket,
		AudioSSRC:    audio_ssrc,
		RtxAudioSSRC: audio_ssrc,
		VideoSSRC:    video_ssrc,
		RtxVideoSSRC: video_ssrc,
		lastPLITime:  time.Now(),
		Protocol:     "Unchosen",
	}
}

func (c *RTCClient) SafeWrite(v interface{}) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return wsjson.Write(context.Background(), c.Socket, v)
}

func (p *RTCClient) setPublishedWebRTCTrack(trackType string, pt *PublishedWebRTCTrack) {
	if trackType == "audio" {
		p.audioWebRTCPublished = pt
	} else {
		p.videoWebRTCPublished = pt
	}
}

func (c *RTCClient) Close() {
	c.recorderMutex.Lock()
	defer c.recorderMutex.Unlock()

	if c.recorder != nil {
		err := c.recorder.Close()
		if err != nil {
			fmt.Printf("Error closing recorder: %v\n", err)
		} else {
			fmt.Println("Recording saved and closed for user:", c.UserID)
		}
		c.recorder = nil
	}

	if c.pc != nil {
		c.pc.Close()
	}

	if c.audioWebRTCPublished != nil {
		close(c.audioWebRTCPublished.stop)
	}
	if c.videoWebRTCPublished != nil {
		close(c.videoWebRTCPublished.stop)
	}
}

func (c *RTCClient) HandleUDP(payload []byte, packetType string) {
	packet := &rtp.Packet{}

	if err := packet.Unmarshal(payload); err != nil {
		fmt.Printf("Failed to unmarshal to RTP: %v\n", err)
		return
	}

	if TestMode {
		//fmt.Printf("Debug: SSRC=%d, Seq=%d, PayloadLen=%d\n", packet.SSRC, packet.SequenceNumber, len(packet.Payload))

		c.recorderMutex.Lock()

		if c.recorder == nil {
			w, err := oggwriter.New(fmt.Sprintf("%s-sfu-out.ogg", c.UserID), 48000, 2)
			if err != nil {
				fmt.Printf("Failed to create ogg file: %v\n", err)
				c.recorderMutex.Unlock()
				return
			}
			c.recorder = w
			fmt.Println("Started recording for user:", c.UserID)
		}

		c.recorder.WriteRTP(packet)
		c.recorderMutex.Unlock()
	}

	ssrc := 0
	lastRTPMu.Lock()

	if packetType == "audio" {
		lastRTP[c.AudioSSRC] = time.Now().UnixMilli()
		ssrc = int(c.AudioSSRC)
	} else {
		lastRTP[c.VideoSSRC] = time.Now().UnixMilli()
		ssrc = int(c.VideoSSRC)
	}

	lastRTPMu.Unlock()

	TryBroadcastUDP(packet, c.ChannelID, c.UserID, uint32(ssrc), packetType)
}

func (c *RTCClient) SendSpeakingEvent(UserID string, SSRC uint32) {
	err := c.SafeWrite(map[string]interface{}{
		"op": OpSpeaking,
		"d": map[string]interface{}{
			"user_id":  UserID,
			"ssrc":     SSRC,
			"speaking": true,
		},
	})
	if err != nil {
		fmt.Printf("Failed to send RTC speaking data to webrtc socket: %v\n", err)
		return
	}
}

func (c *RTCClient) SendUDP(p *rtp.Packet, SSRC uint32) {
	if c.udpSocket != nil {
		raw, err := p.Marshal()
		if err != nil {
			fmt.Printf("Failed to marshal RTP: %v\n", err)
			return
		}

		_, err = c.udpSocket.WriteToUDP(raw, c.udpAddr)
		if err != nil {
			fmt.Printf("Failed to send RTP packet: %v\n", err)
			return
		}
	}
}

func (c *RTCClient) SubscribeToExistingTracks() {
	clientsMu.RLock()

	defer clientsMu.RUnlock()

	for _, other := range clients {
		if other.UserID == c.UserID {
			continue
		}

		if other.ChannelID != c.ChannelID {
			continue
		}

		var videoSSRC uint32 = 0
		var audioSSRC uint32 = 0

		other.mu.Lock()

		if other.masterWebRTCAudio != nil {
			subKeyAudio := other.UserID + "_audio"

			audioSSRC = uint32(other.masterWebRTCAudio.ssrc)
			c.mu.Lock()
			c.subscriptions[subKeyAudio] = true
			c.mu.Unlock()
		}

		if other.masterWebRTCVideo != nil {
			subKeyVideo := other.UserID + "_video"

			videoSSRC = uint32(other.masterWebRTCVideo.ssrc)
			c.mu.Lock()
			c.subscriptions[subKeyVideo] = true
			c.mu.Unlock()

			log.Printf("Subscribed New Client %s to existing %s track from %s", c.UserID, "video", other.UserID)
		}

		c.SafeWrite(map[string]interface{}{
			"op": OpSSRCUpdate,
			"d": map[string]interface{}{
				"user_id":    other.UserID,
				"audio_ssrc": audioSSRC,
				"video_ssrc": videoSSRC,
			},
		})

		other.mu.Unlock()
	}
}

func (c *RTCClient) RequestKeyFrame(ssrc uint32) {
	c.mu.Lock()
    now := time.Now()

    if now.Sub(c.lastPLITime) < time.Second {
        c.mu.Unlock()
        return
    }

    c.lastPLITime = now
    c.mu.Unlock()

    if c.pc == nil {
        return
    }

    // "Someone needs a full frame right fucking now."
    err := c.pc.WriteRTCP([]rtcp.Packet{
        &rtcp.PictureLossIndication{MediaSSRC: ssrc},
    })
    if err != nil {
        fmt.Printf("Error sending PLI: %v\n", err)
    }
}

func (c *RTCClient) SetupPC(sdpFragment string, codecs []Codec) {
	if c.pc != nil {
		return
	}

	log.Println("NEW PEER CONNECTION")

	pc, err := webrtcAPI.NewPeerConnection(webrtc.Configuration{})

	if err != nil {
		fmt.Println("failed to make new pc ")
		return
	}

	opusType := 0
	videoType := 0
	videoBitrate := 2500
	opusBitrate := 64

	for _, codec := range codecs {
        if codec.Type == "audio" && (strings.ToLower(codec.Name) == "opus") {
            opusType = int(codec.PayloadType)
        } else if codec.Type == "video" && (strings.ToLower(codec.Name) == "vp8") {
            videoType = int(codec.PayloadType)
        }
    }

	if opusType == 0 {
        lines := strings.Split(sdpFragment, "\n")
        for _, line := range lines {
            if strings.Contains(line, "opus/48000") {
                parts := strings.Split(line, " ")
                if len(parts) > 0 {
                    ptStr := strings.TrimPrefix(parts[0], "a=rtpmap:")
                    if pt, err := strconv.Atoi(ptStr); err == nil {
                        opusType = pt
                        log.Printf("Legacy Client: Extracted Opus Payload Type %d from SDP", pt)
                    }
                }
            }
            if strings.Contains(line, "VP8/90000") {
                 parts := strings.Split(line, " ")
                 if len(parts) > 0 {
                    ptStr := strings.TrimPrefix(parts[0], "a=rtpmap:")
                    if pt, err := strconv.Atoi(ptStr); err == nil {
                        videoType = pt
                    }
                 }
            }
        }
    }

	if opusType != 0 && c.AudioSSRC != 0 {
		masterAudio := NewMultiplexTrack(webrtc.RTPCodecTypeAudio, "audio", c.UserID, webrtc.SSRC(c.AudioSSRC))

		if _, err := pc.AddTrack(masterAudio); err != nil {
			fmt.Printf("AddTrack audio: %v\n", err)
			return
		}

		c.masterWebRTCAudio = masterAudio
	}

	if videoType != 0 && c.VideoSSRC != 0 {
		masterVideo := NewMultiplexTrack(webrtc.RTPCodecTypeVideo, "video", c.UserID, webrtc.SSRC(c.VideoSSRC))

		if _, err := pc.AddTrack(masterVideo); err != nil {
			fmt.Printf("AddTrack video: %v\n", err)
			return
		}

		c.masterWebRTCVideo = masterVideo
	}

	c.subscriptions = make(map[string]bool)
	c.pc = pc

	c.setupOnWebRTCTrack()

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("Client %s ICE state: %s", c.UserID, state.String())
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("Client %s peer connection state: %s", c.UserID, state.String())
		if state == webrtc.PeerConnectionStateConnected {
			fmt.Printf("Client %s peer connection state: CONNECTED.\n", c.UserID)
		}
	})

	log.Printf("Client %s joined", c.ServerID)

	legacyAnswer := strings.Contains(sdpFragment, "v=")

	var remoteSSRCs []RemoteSSRC

	clientsMu.RLock()
	defer clientsMu.RUnlock()

	for _, client := range clients {
		if client.UserID != c.UserID && client.Protocol == "webrtc" {
			if client.masterWebRTCAudio != nil {
				remoteSSRCs = append(remoteSSRCs, RemoteSSRC{
					SSRC:   int(client.AudioSSRC),
					CName:  client.UserID,
					Typ:    "audio",
					Active: true,
				})
			}

			if client.masterWebRTCVideo != nil {
				remoteSSRCs = append(remoteSSRCs, RemoteSSRC{
					SSRC:   int(client.VideoSSRC),
					CName:  client.UserID,
					Typ:    "video",
					Active: true,
				})
			}
		}
	}

	fullOffer := generateSessionDescription(
		true,
		"offer",
		sdpFragment,
		"sendrecv",
		opusType,
		opusBitrate,
		videoType,
		videoBitrate,
		remoteSSRCs,
	)

	fmt.Printf("%s\n", fullOffer)

	offer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  fullOffer,
	}

	if err := c.pc.SetRemoteDescription(offer); err != nil {
		fmt.Printf("Pion Error Detail: %v\n", err)
		return
	}

	answer, err := c.pc.CreateAnswer(nil)
	if err != nil {
		fmt.Println("failed to set local description")
		return
	}
	if err = c.pc.SetLocalDescription(answer); err != nil {
		fmt.Println("failed to set local description")
		return
	}

	gatherComplete := webrtc.GatheringCompletePromise(c.pc)
	<-gatherComplete

	pionSDP := c.pc.LocalDescription().SDP

	fmt.Printf("Answer: %s\n", pionSDP)

	answerResp := makeAnswer(pionSDP, IP, Port, legacyAnswer)

	if answerResp == "" {
		c.Close()
		c.Socket.Close(websocket.StatusAbnormalClosure, "Failed to generate answer. Piss off.")
		return
	}

	c.SafeWrite(map[string]interface{}{
		"op": OpAnswer,
		"d": map[string]interface{}{
			"sdp":         answerResp,
			"audio_codec": "opus",
			"video_codec": "VP8",
		},
	})
}
