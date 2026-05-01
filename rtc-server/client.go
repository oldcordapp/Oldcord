package main

import "github.com/pion/webrtc/v4"

type RTCClient struct {
	ServerID  string
	UserID    string
	SessionID string
	Token     string
	SSRC      uint32
	Video     bool
	SelfMute  bool
	SelfDeaf  bool
	PeerConnection *webrtc.PeerConnection
	AudioTrack *webrtc.TrackRemote
	VideoTrack *webrtc.TrackRemote
	SubscribedTracks map[string]*webrtc.RTPSender
}

func NewRTCClient(userID string, serverID string, sessionId string, token string, ssrc uint32, video bool) *RTCClient {
	return &RTCClient{
		ServerID:  serverID,
		UserID:    userID,
		SessionID: sessionId,
		Token:     token,
		Video:     video,
	}
}

func (c *RTCClient) Close() {
	
}