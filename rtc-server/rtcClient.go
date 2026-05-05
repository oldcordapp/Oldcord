package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

type RTCClient struct {
	ServerID               string
	UserID                 string
	SessionID              string
	Token                  string
	SSRC                   uint32
	Video                  bool
	SelfMute               bool
	SelfDeaf               bool
	masterWebRTCAudio      *MultiplexTrack
	masterWebRTCVideo      *MultiplexTrack
	isAudioWebRTCPublished bool
	isVideoWebRTCPublished bool
	Socket                 *websocket.Conn
	udpSocket              *net.UDPConn
	mu                     sync.Mutex
	pc                     *webrtc.PeerConnection
	udpAddr                *net.UDPAddr
	audioWebRTCPublished   *PublishedWebRTCTrack
	videoWebRTCPublished   *PublishedWebRTCTrack
	subscriptions          map[string]bool
	recorder               *oggwriter.OggWriter // Keep the writer alive here
	recorderMutex          sync.Mutex
}

type PublishedWebRTCTrack struct {
	track *webrtc.TrackLocalStaticRTP
	ssrc  webrtc.SSRC
	stop  chan struct{}
}

func NewRTCClient(userID string, serverID string, sessionId string, token string, ssrc uint32, video bool, socket *websocket.Conn) *RTCClient {
	return &RTCClient{
		ServerID:  serverID,
		UserID:    userID,
		SessionID: sessionId,
		Token:     token,
		Video:     video,
		Socket:    socket,
		SSRC:      ssrc,
	}
}

func (p *RTCClient) getPublishedWebRTCTrack(trackType string) *PublishedWebRTCTrack {
	if trackType == "audio" {
		return p.audioWebRTCPublished
	}
	return p.videoWebRTCPublished
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
}

func callNode(endpoint string, body interface{}) (string, error) {
	jsonBody, _ := json.Marshal(body)
	resp, err := http.Post(fmt.Sprintf("http://localhost:%s/api/voice/process-%s", strconv.Itoa(RestPort), endpoint), "application/json", bytes.NewBuffer(jsonBody))
	if err != nil {
		return "", err
	}

	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	return string(b), nil
}

func (c *RTCClient) HandleUDP(payload []byte) {
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

	TryBroadcastUDP(packet, c.ServerID, c.UserID, c.SSRC)
}

func (c *RTCClient) SendSpeakingEvent(UserID string, SSRC uint32) {
	err := wsjson.Write(context.Background(), c.Socket, map[string]interface{}{
		"op": 5,
		"d": map[string]interface{}{
			"user_id": UserID,
			"ssrc":    SSRC,
			"delay":   0,
		},
	})
	if err != nil {
		fmt.Printf("Failed to send RTC speaking data to webrtc socket: %v\n", err)
		return
	}
}

func (c *RTCClient) SendUDP(p *rtp.Packet, SSRC uint32) {
	fmt.Println("Sending udp!!!")
	if c.udpSocket != nil {
		fmt.Println("socket not null sending")
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

func (c *RTCClient) SetupPC(sdpFragment string, codecs []Codec) {
	if c.pc != nil {
		return
	}

	pc, err := webrtcAPI.NewPeerConnection(webrtc.Configuration{})

	if err != nil {
		fmt.Println("failed to make new pc ")
		return
	}

	// create the single downstream tracks for Audio and Video multiplexing
	masterAudio := NewMultiplexTrack(webrtc.RTPCodecTypeAudio, "audio", "multiplex")
	masterVideo := NewMultiplexTrack(webrtc.RTPCodecTypeVideo, "video", "multiplex")

	// add them to the peer connection immediately so they are included in the initial Offer/Answer
	if _, err := pc.AddTrack(masterAudio); err != nil {
		fmt.Printf("AddTrack audio: %v\n", err)
		return
	}

	if _, err := pc.AddTrack(masterVideo); err != nil {
		fmt.Printf("AddTrack video: %v\n", err)
		return
	}

	c.masterWebRTCAudio = masterAudio
	c.masterWebRTCVideo = masterVideo
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

	fullOffer := sdpFragment
	legacyOffer := true

	if !strings.Contains(sdpFragment, "v=0") {
		fullOfferTemp, err := callNode("offer", map[string]interface{}{
			"sdpFragment": sdpFragment,
			"codecs":      codecs,
		})
		if err != nil {
			fmt.Printf("Failed to process offer. Are you sure the Oldcord REST API is up?: %v\n", err)
			return
		}

		fullOffer = fullOfferTemp
		legacyOffer = false
	}

	fmt.Printf("%s\n", fullOffer)

	if legacyOffer {
		fmt.Println("Handling legacy (2015-Jan 23 2017) offer...")
	}

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

	sdpAnswer := pionSDP

	if !legacyOffer {
		sctp := c.pc.SCTP().Transport()
		dtlsParams, _ := sctp.GetLocalParameters()
		fp := dtlsParams.Fingerprints[0]
		actualFP := fp.Algorithm + " " + strings.ToUpper(fp.Value)

		sdpAnswerTemp, err := callNode("answer", map[string]interface{}{
			"pionSdp":     pionSDP,
			"publicIp":    IP,
			"publicPort":  Port,
			"fingerprint": actualFP,
		})
		if err != nil {
			fmt.Printf("Failed to make answer. Are you sure the Oldcord REST API is up?: %v\n", err)
			return
		}

		sdpAnswer = sdpAnswerTemp
	} else {
		fmt.Println("Handling legacy (2015-Jan 23 2017) answer...")
	}

	wsjson.Write(context.Background(), c.Socket, map[string]interface{}{
		"op": OpAnswer,
		"d": map[string]interface{}{
			"sdp":         sdpAnswer,
			"audio_codec": "opus",
			"video_codec": "VP8",
		},
	})
}
