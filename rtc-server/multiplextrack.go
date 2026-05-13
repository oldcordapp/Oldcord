// https://github.com/spacebarchat/pion-webrtc/blob/main/pion-sfu/multiplextrack.go#L25
// FULL CREDITS TO S074. I DID NOT WRITE THIS, BUT IT WORKS SO WELL SO I AM USING IT.
package main

import (
	"fmt"
	"sync"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type trackBinding struct {
	payloadType uint8
	ssrc        uint32
	writeStream webrtc.TrackLocalWriter
}

// custom TrackLocal to pass RTP packets without SSRC rewrite
type MultiplexTrack struct {
	mu       sync.RWMutex
	id       string
	streamID string
	kind     webrtc.RTPCodecType
	ssrc     webrtc.SSRC
	bindings map[webrtc.SSRC]*trackBinding
}

func NewMultiplexTrack(kind webrtc.RTPCodecType, id, streamID string, ssrc webrtc.SSRC) *MultiplexTrack {
	return &MultiplexTrack{
		id:       id,
		streamID: streamID,
		kind:     kind,
		ssrc:     ssrc,
		bindings: make(map[webrtc.SSRC]*trackBinding),
	}
}

func (t *MultiplexTrack) SSRC() webrtc.SSRC {
    return t.ssrc
}

func (t *MultiplexTrack) Bind(ctx webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	var negotiatedCodec webrtc.RTPCodecParameters
	var found bool
	expectedMime := webrtc.MimeTypeOpus
	if t.kind == webrtc.RTPCodecTypeVideo {
		expectedMime = webrtc.MimeTypeH264
	}

	for _, c := range ctx.CodecParameters() {
		// pion/webrtc MimeType strings are case-insensitive or generally exact match,
		// but we can just use the constants which match natively.
		if c.MimeType == expectedMime {
			negotiatedCodec = c
			found = true
			break
		}
	}

	if !found {
		return webrtc.RTPCodecParameters{}, fmt.Errorf("could not find compatible codec for track")
	}

	t.bindings[ctx.SSRC()] = &trackBinding{
		payloadType: uint8(negotiatedCodec.PayloadType),
		ssrc:        uint32(ctx.SSRC()),
		writeStream: ctx.WriteStream(),
	}
	return negotiatedCodec, nil
}

func (t *MultiplexTrack) Unbind(ctx webrtc.TrackLocalContext) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.bindings, ctx.SSRC())
	return nil
}

func (t *MultiplexTrack) ID() string { return t.id }
func (t *MultiplexTrack) StreamID() string { return t.streamID }
func (t *MultiplexTrack) Kind() webrtc.RTPCodecType { return t.kind }
func (t *MultiplexTrack) RID() string { return "" }

func (t *MultiplexTrack) WriteRTP(p *rtp.Packet) error {
	t.mu.RLock()
	defer t.mu.RUnlock()

	// write without rewriting the SSRC, but DO rewrite the Payload Type!
	// keeping the sender SSRC simplifies our signaling work. However, payload type 
	// must be kept from the receiver client offer since each browser uses a different one
	for _, b := range t.bindings {
		p.Header.PayloadType = b.payloadType
        p.Header.SSRC = b.ssrc

		if _, err := b.writeStream.WriteRTP(&p.Header, p.Payload); err != nil {
			return err
		}
	}
	return nil
}