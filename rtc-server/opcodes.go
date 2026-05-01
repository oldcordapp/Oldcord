package main

type OpCode int

const (
	OpIdentify OpCode = iota // 0
	OpSelectProtocol // 1
	OpReady // 2
	OpHeartbeat // 3
	OpAnswer // 4
	OpFiller1 // 5
	OpHeartbeatAck // 6
	OpHello = 8
)

type Identify struct {
	ServerID  string `json:"server_id"`
	UserID    string `json:"user_id"`
	SessionID string `json:"session_id"`
	Token     string `json:"token"`
	Video     bool   `json:"video"`
}

type Codec struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Priority int32 `json:"priority"`
	PayloadType int32 `json:"payload_type"`
	RtxPayloadType int32 `json:"rtx_payload_type"`
}

type SelectProtocol struct {
	Protocol string `json:"protocol"`
	Data string `json:"data"`
	SDP string `json:"sdp,omitempty"`
	Codecs []Codec `json:"codecs"`
}

type Ready struct {
	SSRC 	uint32 	`json:"ssrc"`
	IP 		string 	`json:"ip"`
	Port	int		`json:"port"`
	Modes 	[]string `json:"modes"`
	HeartbeatInterval	int		`json:"heartbeat_interval"`
}