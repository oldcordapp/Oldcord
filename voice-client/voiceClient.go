package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

type VoiceClient struct {
	SendingTestAudio bool
	Protocol string
	Socket *websocket.Conn
	UdpSocket *net.UDPConn
	UdpAddr *net.UDPAddr
	ServerID string
	UserID string
	SSRC uint32
	recorder         *oggwriter.OggWriter
    recorderMutex    sync.Mutex
}

func (vc *VoiceClient) performIPDiscovery() (string, uint16) {
	req := make([]byte, 70)
	binary.BigEndian.PutUint16(req[0:2], 1)
	binary.BigEndian.PutUint16(req[2:4], 70)
	binary.BigEndian.PutUint32(req[4:8], vc.SSRC)
	vc.UdpSocket.WriteToUDP(req, vc.UdpAddr)

	buf := make([]byte, 70)
	n, _, _ := vc.UdpSocket.ReadFromUDP(buf)

	if n < 70 {
		return "127.0.0.1", 0
	}

	extIP := string(buf[8 : n-2])
	extPort := binary.BigEndian.Uint16(buf[68:70])

	fmt.Printf("Discovered External IP: %s:%d\n", extIP, extPort)
	return extIP, extPort
}

func startHeartbeat(ctx context.Context, c *websocket.Conn, interval time.Duration) {
	ticker := time.NewTicker(interval)
	for range ticker.C {
		wsjson.Write(ctx, c, map[string]interface{}{
			"op": 3,
			"d":  time.Now().Unix(),
		})
	}
}

func (vc *VoiceClient) receiveAudio() {
	buf := make([]byte, 1500)

	fmt.Println("Listening for incoming audio...")

	for {
		fmt.Println("Listening for incoming audio 2...")

		n, addr, err := vc.UdpSocket.ReadFromUDP(buf)
		if err != nil {
			fmt.Println("UDP read error:", err)
			continue
		}

		fmt.Println("hello")
		if n < 12 {
			continue 
		}

		packet := buf[:n]

		payloadType := packet[1] & 0x7F
		sequence := binary.BigEndian.Uint16(packet[2:4])
		timestamp := binary.BigEndian.Uint32(packet[4:8])
		ssrc := binary.BigEndian.Uint32(packet[8:12])

		payload := packet[12:]

		rtpPacket := &rtp.Packet{}

		if err := rtpPacket.Unmarshal(packet); err != nil {
			fmt.Printf("Failed to unmarshal to RTP: %v\n", err)
			return
		}

		fmt.Printf(
			"Received RTP packet from %s | SSRC=%d Seq=%d TS=%d PT=%d Size=%d\n",
			addr.String(), ssrc, sequence, timestamp, payloadType, len(payload),
		)

		vc.recorderMutex.Lock()

		if vc.recorder == nil {
			w, err := oggwriter.New(fmt.Sprintf("%d-sfu-out.ogg", ssrc), 48000, 2)

			if err != nil {
				fmt.Printf("Failed to create ogg file: %v\n", err)
				vc.recorderMutex.Unlock()
				return
			}

			vc.recorder = w
			fmt.Println("Started recording for user: " + vc.UserID)
		}

		vc.recorder.WriteRTP(rtpPacket)
    	vc.recorderMutex.Unlock()
	}
}

func (client *VoiceClient) handleSignaling(ctx context.Context) {
	var ssrc uint32
	var udpConn *net.UDPConn
	var serverAddr *net.UDPAddr

	for {
		var msg map[string]interface{}
		err := wsjson.Read(ctx, client.Socket, &msg)
		if err != nil {
			fmt.Println("Read error:", err)
			return
		}

		opFloat, ok := msg["op"].(float64)
        if !ok {
            fmt.Println("Received message without valid op code")
            continue
        }
        op := int(opFloat)

        fmt.Printf("Received Op: %d\n", op)

		data, _ := msg["d"].(map[string]interface{})

		switch op {
		case 8:
			go startHeartbeat(ctx, client.Socket, time.Duration(data["heartbeat_interval"].(float64))*time.Millisecond)
			fmt.Println("Started heartbeat")
		case 2:
			ssrc = uint32(data["ssrc"].(float64))
			ip := data["ip"].(string)
			port := int(data["port"].(float64))

			client.SSRC = ssrc

			if client.Protocol == "udp" {
				serverAddr, _ = net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", ip, port))
				udpConn, _ = net.ListenUDP("udp", nil)

				client.UdpAddr = serverAddr
				client.UdpSocket = udpConn

				extIP, extPort := client.performIPDiscovery()

				wsjson.Write(ctx, client.Socket, map[string]interface{}{
					"op": 1,
					"d": map[string]interface{}{
						"protocol": "udp",
						"data": map[string]interface{}{
							"address": extIP,
							"port":    extPort,
							"mode":    "plain",
						},
					},
				})

				fmt.Println("Sent OP 1")
			}
		case 4:
			if client.Protocol == "udp" {
					fmt.Println("Handshake Complete!")

					if client.SendingTestAudio {
						fmt.Println("Sending test audio..")
						
						opusFile := ReadOggFromFile(opusOggFile)

						if opusFile != nil {
							packets := ReadOpusPackets(opusFile)

							if len(packets) > 0 {
								StreamFromOpusPackets(udpConn, serverAddr, packets, ssrc, 111)
							}
						}
					} else {
						go client.receiveAudio()
					}
			}
		case 5:
			ssrc = uint32(data["ssrc"].(float64))
			user_id := data["user_id"].(string)

			fmt.Printf("Client %s (SSRC: %d) is speaking! We are recording their data right now.\n", user_id, ssrc)
		}
	}
}

func NewVoiceClient(rtcServerURL string, protocol string, serverID string, userID string, sessionID string, token string, sender bool) *VoiceClient {
	ctx := context.Background()
	c, _, err := websocket.Dial(ctx, rtcServerURL, nil)

	if err != nil {
		panic(err)
	}

	err = wsjson.Write(ctx, c, map[string]interface{}{
		"op": 0,
		"d": map[string]interface{}{
			"server_id":  serverID,
			"user_id":    userID,
			"session_id": sessionID,
			"token":      token,
		},
	})

	client := &VoiceClient{
		SendingTestAudio: sender,
		Protocol: protocol,
		Socket: c,
		UdpSocket: nil,
		UdpAddr: nil,
		ServerID: serverID,
		UserID: userID,
		SSRC: 0,
	}

	client.handleSignaling(ctx)

	return client
}