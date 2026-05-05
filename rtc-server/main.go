package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/joho/godotenv"
	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

var (
    pendingSessions = make(map[string]SyncData)
    sessionMu sync.RWMutex
	clients = make(map[string]*RTCClient)
	clientsMu sync.RWMutex
	RTC_SECRET_KEY string
	IP string
	TestMode bool
	Port int
	UDPPort int
	RestPort int
	webrtcAPI *webrtc.API
)

func VerifyConnection(serverId string, userId string, sessionId string, token string) (SyncData, bool) {
	sessionMu.RLock()
    defer sessionMu.RUnlock()

    for k, v := range pendingSessions {
        if k == token {
            return v, true
        }
    }

    return SyncData{}, false
}

func AddClient(client *RTCClient) {
    clientsMu.Lock()
    defer clientsMu.Unlock()
    clients[client.UserID] = client
}

func RemoveClient(userID string) {
    clientsMu.Lock()
    defer clientsMu.Unlock()
    delete(clients, userID)
}

func FindClientBySSRC(ssrc uint32) *RTCClient {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	
	for _, v := range clients {
		if v.SSRC == ssrc {
			return v
		}
	}

	return nil
}

func TryBroadcastUDP(p *rtp.Packet, serverId string, senderID string, senderSSRC uint32) {
	clientsMu.RLock();
	defer clientsMu.RUnlock();

	for _, client := range clients {
		if client.ServerID == serverId && client.SSRC != senderSSRC {
			//fmt.Printf("Server ID: %s - User ID: %s - SSRC %d\n", client.ServerID, client.UserID, client.SSRC)
			if client.masterWebRTCAudio != nil {
				//We may need to change the SSRC somehow before dispatching it to the other webrtc clients
				client.masterWebRTCAudio.WriteRTP(p)
			}

			if client.pc == nil {
				client.SendUDP(p, senderSSRC)
			}

			client.SendSpeakingEvent(senderID, senderSSRC)
		}
	}
}

//So voice (2015* - 2018) works like this * - Depends as webrtc-p2p was only added in Jan 31 2017 and removed sometime in 2019 or so.
//Client joins the vc -> Sends an Identify payload & Select Protocol with these options, webrtc-p2p, udp, webrtc. 
//The RTC Server initializes their connection, makes a new voice room (if one is not present for the channel currently), or assigns them an existing one.
//Afterwards, the server sends a ready payload, with information about the webrtc SFU ip & port or undelying UDP server & port.
//Shortly thereafter, if the Client chose webrtc, there would be an answer exchanged back from the SFU - outlining the ICE candidates, and DTLS fingerprint, etc. And what codecs, etc the server supports.
//The client would then send an OP 5 with their SSRC whenever they're speaking (And yes, even though UDP Has no use for SSRCs, they are assigned one anyways - and it tracks their connection, etc props on the RTC server)
//When the client does speak, it must send encrypted RTP (Real Time Transfer Protocol) packets with the appropriate codec & encryption method. WebRTC does this under the hood with SRTP.
//Now the problem is, we must handle both WebRTC clients and raw UDP clients, to do this - we can hook the onTrack method of the pion webrtc connection. And get the raw SRTP, decrypt, translate and forward it to other raw UDP clients in the current room.
//For the other way around, we can just transform the RTP -> decrypt it (if encrypted of course) and pass it to pion with create local track, then forward that to other webrtc clients in the room.

func generateSSRC() uint32 {
	var b [4]byte
	_, err := rand.Read(b[:])
	if err != nil {
		panic(err) // or handle properly
	}
	return binary.BigEndian.Uint32(b[:])
}

func handleIdentify(msgD json.RawMessage, c *websocket.Conn, ctx context.Context, currentUserID *string) {
	var d Identify

	if err := json.Unmarshal(msgD, &d); err != nil {
		fmt.Println("Identify Unmarshal error:", err)
		return
	}

	sessionData, ok := VerifySession(d.Token)

	if sessionData.ServerID != d.ServerID && sessionData.UserID != d.UserID && sessionData.SessionID != d.SessionID && !TestMode {
		fmt.Printf("User %s tried to force their way in with an invalid matching session ID & Token from the gateway server. They have been blocked.\n", d.UserID)
		c.Close(4004, "Authentication failed")
		return
	}

	if !ok && !TestMode {
		fmt.Printf("User %s tried to force their way in with an invalid matching session ID & Token from the gateway server. They have been blocked.\n", d.UserID)
		c.Close(4004, "Authentication failed")
		return
	}

	fmt.Printf("User %s verified for server %s\n", d.UserID, d.ServerID)

	ssrc := generateSSRC()
	client := NewRTCClient(d.UserID, d.ServerID, d.SessionID, d.Token, ssrc, d.Video, c)

	if currentUserID != nil {
		*currentUserID = d.UserID
	}

	AddClient(client)

	fmt.Printf("User %s added to active clients.\n", client.UserID)

	wsjson.Write(ctx, c, map[string]interface{}{
		"op": OpReady,
		"d": map[string]interface{}{
			"ssrc":         ssrc,
			"ip": IP,
			"port": UDPPort,
			"modes": []string{
				"xsalsa20_poly1305",
				"plain",
			},
			"heartbeat_interval" : 41250,
		},
	})

	//CheckAndForwardExistingTracks(client.ServerID, client.UserID)
}

func (c *RTCClient) setupOnWebRTCTrack() {
	c.pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		var trackType string
		if remoteTrack.Kind() == webrtc.RTPCodecTypeAudio && remoteTrack.Codec().MimeType == webrtc.MimeTypeOpus {
			trackType = "audio"
		} else if remoteTrack.Kind() == webrtc.RTPCodecTypeVideo && remoteTrack.Codec().MimeType == webrtc.MimeTypeH264 {
			trackType = "video"

			/**
			// send a PLI on an interval so that the publisher is pushing a keyframe every rtcpPLIInterval
			// do we need this? takes a while to see the video otherwise
			go func() {
				ticker := time.NewTicker(time.Second * 3)
				for range ticker.C {
					errSend := p.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(remoteTrack.SSRC())}})
					if errSend != nil {
						fmt.Println(errSend)
					}
				}
			}()
			*/
		} else {
			log.Printf("Client %s started publishing unknown track type %s", c.UserID, remoteTrack.Codec().MimeType)
			return;
		}

		ssrc := webrtc.SSRC(remoteTrack.SSRC())

		pt := &PublishedWebRTCTrack{
			ssrc: ssrc,
			stop: make(chan struct{}),
		}
		
		c.mu.Lock()
		c.setPublishedWebRTCTrack(trackType, pt)
		c.mu.Unlock()

		log.Printf("Client %s started publishing %s (SSRC: %d)", c.UserID, trackType, ssrc)

		// Forward RTP packets to all subscribed peers
		go func() {
			subKey := c.UserID + "_" + trackType

			for {
				select {
				case <-pt.stop:
					return
				default:
				}

				rtpPkt, _, readErr := remoteTrack.ReadRTP()
				if readErr != nil {
					log.Printf("Track read error for %s/%s: %v", c.UserID, trackType, readErr)
					return
				}

				if !c.isAudioWebRTCPublished && trackType == "audio" || !c.isVideoWebRTCPublished && trackType == "video" {
					// if we are not publishing this track, skip forwarding it
					continue;
				}

				// Preserve original SSRC so the client can demultiplex
				rtpPkt.SSRC = uint32(ssrc)

				// Fan-out to all subscribers
				clientsMu.RLock()
				for _, other := range clients {
					other.mu.Lock()
					isSubscribed := other.subscriptions[subKey]
					var masterTrack *MultiplexTrack
					if trackType == "audio" {
						masterTrack = other.masterWebRTCAudio
					} else {
						masterTrack = other.masterWebRTCVideo
					}
					other.mu.Unlock()

					if isSubscribed && masterTrack != nil {
						if writeErr := masterTrack.WriteRTP(rtpPkt); writeErr != nil {
							// don't spam on closed channels
							// log.Printf("Track write error to subscriber %s: %v", other.id, writeErr)
						}
					}
				}
				clientsMu.RUnlock()
			}
		}()
	})
}

func GetWebRTCP2PPeers(exclusionId string) []string {
	clientsMu.RLock()
	defer clientsMu.RUnlock()

	outPeers := make([]string, 0)

	for _, client := range clients {
		if client.UserID != exclusionId {
			outPeers = append(outPeers, client.UserID)
		}
	}

	return outPeers
}

func handleSelectProtocol(msgD json.RawMessage, c *websocket.Conn, currentUserID string) {
	var payload SelectProtocol

	if err := json.Unmarshal(msgD, &payload); err != nil {
		fmt.Println("SelectProtocol Unmarshal error:", err)
		return
	}

	switch(payload.Protocol) {
		case "udp":
			var udpInfo UDPData

			if err := json.Unmarshal(payload.Data, &udpInfo); err != nil {
				fmt.Println("SelectProtocol (UDP) Unmarshal error: ", err)
				return
			}

			if udpInfo.Mode != "plain" {
				fmt.Printf("Unsupported UDP encryption mode: %s\n", udpInfo.Mode)
				return
			}

			wsjson.Write(context.Background(), c, map[string]interface{}{
				"op": OpAnswer,
				"d": map[string]interface{}{
					"mode": "plain",
					"secret_key": nil,
				},
			})
		case "webrtc":
			var sdp string

			if err := json.Unmarshal(payload.Data, &sdp); err != nil {
				fmt.Println("Error parsing initial client offer: ", err)
				return
			}

			sdpFragment := payload.SDP

			if sdpFragment == "" {
				sdpFragment = sdp
			}

			clients[currentUserID].SetupPC(sdpFragment, payload.Codecs)
		case "webrtc-p2p":
			peers := GetWebRTCP2PPeers(currentUserID)

			wsjson.Write(context.Background(), c, map[string]interface{}{
				"op": OpAnswer,
				"d": map[string]interface{}{
					"peers": peers,
				},
			})
		default:
			c.Close(4012, "Unknown protocol")
			return
	}
}

func handleSignal(msgD json.RawMessage, currentUserID string) {
	var payload Signal

	if err := json.Unmarshal(msgD, &payload); err != nil {
		fmt.Println("Signal Unmarshal error:", err)
		return
	}

	clientsMu.RLock()
	defer clientsMu.RUnlock()
	recipient := clients[payload.UserID]

    if recipient == nil {
        fmt.Printf("Couldn't forward webrtc-p2p signal to %s\n", payload.UserID)
        return
    }

	payload.UserID = currentUserID

	forwarded := map[string]interface{}{
        "op": OpSignal,
        "d":  payload,
    }

	err := wsjson.Write(context.Background(), recipient.Socket, forwarded)
    if err != nil {
        fmt.Printf("Failed to forward webrtc-p2p signal: %v\n", err)
        return
    }

    fmt.Printf("Forwarded webrtc-p2p signal from %s -> %s\n", currentUserID, recipient.UserID)
}

func handleSignaling(writer http.ResponseWriter, request *http.Request) {
	c, err := websocket.Accept(writer, request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})

	if err != nil {
		fmt.Println("Failed to accept client: ", err)
		return
	}

	defer c.Close(websocket.StatusInternalError, "Connection Closed")

	var currentUserID string

    defer func() {
        if currentUserID != "" {
			clientsMu.Lock()
			client, exists := clients[currentUserID]
			if exists {
				client.Close()
				delete(clients, currentUserID)
			}
			clientsMu.Unlock()
			fmt.Printf("User %s disconnected.\n", currentUserID)
		}
    }()

	ctx := request.Context()

	wsjson.Write(ctx, c, map[string]interface{}{
        "op": OpHello,
        "d": map[string]interface{}{
            "heartbeat_interval": 41250,
        },
    })

	for {
        var msg struct {
            Op int             `json:"op"`
            D  json.RawMessage `json:"d"`
        }

        err := wsjson.Read(ctx, c, &msg)
        if err != nil {
            fmt.Println("Read error:", err)
            return
        }

		switch msg.Op {
			case int(OpIdentify):
				handleIdentify(msg.D, c, ctx, &currentUserID)
			case int(OpHeartbeat):
				wsjson.Write(ctx, c, map[string]interface{}{
					"op": OpHeartbeatAck,
					"d":  msg.D,
				})
			case int(OpSelectProtocol):
				handleSelectProtocol(msg.D, c, currentUserID)
			case int(OpSignal):
				handleSignal(msg.D, currentUserID)
		}
	}
}

func AddSession(data SyncData) {
    sessionMu.Lock()
    defer sessionMu.Unlock()
    pendingSessions[data.Token] = data
}

func VerifySession(token string) (SyncData, bool) {
    sessionMu.Lock()
    defer sessionMu.Unlock()
    
    data, exists := pendingSessions[token]

    return data, exists
}

func handleSync(writer http.ResponseWriter, request* http.Request) {
	if RTC_SECRET_KEY == "" || request.Header.Get("Authorization") != "Bearer " + RTC_SECRET_KEY {
		http.Error(writer, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var data SyncData
    if err := json.NewDecoder(request.Body).Decode(&data); err != nil {
        return
    }

    AddSession(data)
    writer.WriteHeader(http.StatusOK)
	fmt.Printf("Authorized new user: %s to join vc in %s with %s\n", data.UserID, data.ServerID, data.Token)
}

func GetOutboundIP() net.IP {
    conn, err := net.Dial("udp", "8.8.8.8:80")
    if err != nil {
        log.Fatal(err)
    }
    defer conn.Close()

    localAddr := conn.LocalAddr().(*net.UDPAddr)

    return localAddr.IP
}

func createMediaEngine() (*webrtc.MediaEngine, error) {
	m := &webrtc.MediaEngine{}

	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeOpus,
			ClockRate:   48000,
			Channels:    2,
			SDPFmtpLine: "minptime=10;usedtx=1;useinbandfec=1",
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}

	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			ClockRate:   90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-max-bitrate=2500",
			RTCPFeedback: nil,
		},
		PayloadType: 103,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeRTX,
			ClockRate:   90000,
			SDPFmtpLine: "apt=103",
			RTCPFeedback: nil,
		},
		PayloadType: 104,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}

	return m, nil
} // https://github.com/spacebarchat/pion-webrtc/blob/main/pion-sfu/main.go#L33

func handleIPDiscovery(conn *net.UDPConn, remoteAddr *net.UDPAddr, ssrc uint32) {
	packet := make([]byte, 70) //allocate 70 byte packet

	binary.BigEndian.PutUint16(packet[0:2], 2) // response 0x2
	binary.BigEndian.PutUint16(packet[2:4], 70) // packet length
	binary.BigEndian.PutUint32(packet[4:8], ssrc) // ssrc uint32

	ipStr := remoteAddr.IP.String()
	copy(packet[8:], ipStr) //copy ip string into space at index 8

	binary.BigEndian.PutUint16(packet[68:70], uint16(remoteAddr.Port))

	_, err := conn.WriteToUDP(packet, remoteAddr)
	if err != nil {
		fmt.Printf("Error sending IP discovery response: %v\n", err)
	}
}

func StartUDPHandler(port int) {
	addr, _ := net.ResolveUDPAddr("udp", fmt.Sprintf(":%d", port))
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		log.Fatalf("failed to bind UDP socket on %d: %v", port, err)
	}

	go func() {
        buf := make([]byte, 1500)

        for {
            n, remoteAddr, _ := conn.ReadFromUDP(buf)
    
            if n == 70 {
                ssrc := binary.BigEndian.Uint32(buf[4:8])
                handleIPDiscovery(conn, remoteAddr, ssrc)

				client := FindClientBySSRC(ssrc)

				if client != nil {
					client.udpAddr = remoteAddr
					client.udpSocket = conn
				}
				
				fmt.Println("IP Discovery performed")
            } else if n > 70 {
				ssrc := binary.BigEndian.Uint32(buf[8:12])

				client := FindClientBySSRC(ssrc)

				if client != nil {
					client.HandleUDP(buf[:n])
				}
			}
        }
    }()
}

func main() {
	err := godotenv.Load()
	if err != nil {
		log.Fatal("Error loading .env file")
	}

	if len(os.Args) < 4 {
		fmt.Println("Rtc-server must be run with a RTC server port, UDP port, and rest port.\nExample: go run . 3240 4240 1337")
		return
	}

	Port, err := strconv.Atoi(os.Args[1])
	if err != nil {
		log.Fatal("Invalid RTC port")
	}

	UDPPort, err := strconv.Atoi(os.Args[2])
	if err != nil {
		log.Fatal("Invalid UDP port")
	}

	RestPortTemp, err := strconv.Atoi(os.Args[3])
	if err != nil {
		log.Fatal("Invalid REST port")
	}

	RestPort = RestPortTemp //SHUT UP GOLANG IVE USED THIS PORT IN RTCCLIENT. YES I HAVE.
	
	RTC_SECRET_KEY = os.Getenv("RTC_SECRET_KEY");
	IP = GetOutboundIP().String()
	TestMode = true
	mediaEngine, err := createMediaEngine()

	settingEngine := webrtc.SettingEngine{}
	settingEngine.SetLite(true)

	// restrict to UDP4 to improve compatibility with Firefox's strict ICE parser
	settingEngine.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})

	// this is so that the sdp offer always sends our public IP
	// in case our SFU server is behind NAT
	settingEngine.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
		External:      []string{IP},
		AsCandidateType: webrtc.ICECandidateTypeHost,
		Mode:          webrtc.ICEAddressRewriteReplace,
	})

	// debug logging, remove when done
	logFactory := logging.NewDefaultLoggerFactory()
	logFactory.DefaultLogLevel = logging.LogLevelDebug
	settingEngine.LoggerFactory = logFactory

	// all of our traffic will be coming from a single port, and multiplexed
	mux, err := ice.NewMultiUDPMuxFromPort(Port)

	if err != nil {
		log.Fatalf("NewMultiUDPMuxFromPort: %v", err)
	}

	settingEngine.SetICEUDPMux(mux)

	// Create an InterceptorRegistry. This is the user configurable RTP/RTCP Pipeline.
	// This provides NACKs, RTCP Reports and other features. If you use `webrtc.NewPeerConnection`
	// this is enabled by default. If you are manually managing You MUST create a InterceptorRegistry
	// for each PeerConnection.
	interceptorRegistry := &interceptor.Registry{}

	// We want TWCC in case the subscriber supports it
	if err = webrtc.ConfigureTWCCSender(mediaEngine, interceptorRegistry); err != nil {
		panic(err)
	}

	if err = webrtc.ConfigureRTCPReports(interceptorRegistry); err != nil {
		panic(err)
	}

	webrtcAPI = webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithSettingEngine(settingEngine),
		webrtc.WithInterceptorRegistry(interceptorRegistry),
	)

	http.HandleFunc("/", handleSignaling);
	http.HandleFunc("/internal/sync", handleSync)
	StartUDPHandler(UDPPort)
	fmt.Println("[OLDCORD] RTC Server v2.0 is up on " + IP + ":" + strconv.Itoa(Port))
	log.Fatal(http.ListenAndServe(":" + strconv.Itoa(Port), nil))
}