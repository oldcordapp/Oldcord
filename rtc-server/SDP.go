package main

import (
	"fmt"
	"strconv"
	"strings"
)

type SSRC struct {
	attribute string
	id int
	value string
}

type RemoteSSRC struct {
	SSRC   int
	CName  string
	Typ    string
	Active bool
}

type MediaExt struct {
	direction string
	encryptUri string
	uri string
	config string
	value int
}

type MediaRTP struct {
	payload int
    codec string
    rate int
    encoding int
}

type MediaFMTP struct {
	payload int
	config string
}

type MediaBandwidth struct {
	typ string
	limit int
}

type MediaRTCPFB struct {
	payload string
    typ string
    subtype string
}

type Media struct {
	typ string
	protocol string
	payloads int
	setup string
	mid string
	rtcpMux string
	direction string
	msid string
	ssrcs []SSRC
	ext []MediaExt
	rtp []MediaRTP
	rtcpFb []MediaRTCPFB
	fmtp []MediaFMTP
	maxptime int
	bandwidth []MediaBandwidth
	fingerprint string
    iceUfrag    string
    icePwd      string
	candidates  []string //for the answer
}

func makeSSRC(userID string, ssrc int, sentinel string) []SSRC {
	mslabel := fmt.Sprintf("%s-%d", userID, ssrc)
	label := fmt.Sprintf("%s%s", sentinel, mslabel)

	return []SSRC{
		{attribute: "cname", id: ssrc, value: mslabel},
		{attribute: "msid", id: ssrc, value: fmt.Sprintf("%s %s", mslabel, label)},
		{attribute: "mslabel", id: ssrc, value: mslabel},
		{attribute: "label", id: ssrc, value: label},
	}
}

func parseAttribute(val string, m *Media) {
	attrParts := strings.SplitN(val, ":", 2)
	attrName := attrParts[0]

	switch attrName {
		case "sendrecv", "sendonly", "recvonly", "inactive":
			m.direction = attrName
			return
		case "rtcp-mux":
			m.rtcpMux = "rtcp-mux"
			return
		}

		if len(attrParts) < 2 {
			return
		}
		attrVal := attrParts[1]

		switch attrName {
			case "setup":
				m.setup = attrVal
			case "mid":
				m.mid = attrVal
			case "msid":
				m.msid = attrVal
			case "fingerprint":
				m.fingerprint = attrParts[1]
			case "ice-ufrag":
				m.iceUfrag = attrParts[1]
			case "ice-pwd":
				m.icePwd = attrParts[1]
			case "maxptime":
				m.maxptime, _ = strconv.Atoi(attrVal)
			case "candidate":
				m.candidates = append(m.candidates, val)

			case "rtpmap":
				// <payload> <codec>/<rate>[/<encoding>]
				fields := strings.Fields(attrVal)
				if len(fields) >= 2 {
					payload, _ := strconv.Atoi(fields[0])
					codecParts := strings.Split(fields[1], "/")
					rtp := MediaRTP{payload: payload, codec: codecParts[0]}
					if len(codecParts) >= 2 {
						rtp.rate, _ = strconv.Atoi(codecParts[1])
					}
					if len(codecParts) >= 3 {
						rtp.encoding, _ = strconv.Atoi(codecParts[2])
					}
					m.rtp = append(m.rtp, rtp)
				}

			case "fmtp":
				// <payload> <config>
				fields := strings.SplitN(attrVal, " ", 2)
				if len(fields) == 2 {
					payload, _ := strconv.Atoi(fields[0])
					m.fmtp = append(m.fmtp, MediaFMTP{payload: payload, config: fields[1]})
				}

			case "ssrc":
				// <id> <attribute>[:<value>]
				fields := strings.Fields(attrVal)
				if len(fields) >= 2 {
					id, _ := strconv.Atoi(fields[0])
					ssrc := SSRC{id: id}
					kv := strings.SplitN(fields[1], ":", 2)
					ssrc.attribute = kv[0]
					if len(kv) == 2 {
						ssrc.value = kv[1]
					}
					m.ssrcs = append(m.ssrcs, ssrc)
				}

			case "rtcp-fb":
				// <payload> <type> [<subtype>]
				fields := strings.Fields(attrVal)
				if len(fields) >= 2 {
					fb := MediaRTCPFB{payload: fields[0], typ: fields[1]}
					if len(fields) >= 3 {
						fb.subtype = fields[2]
					}
					m.rtcpFb = append(m.rtcpFb, fb)
				}

			case "extmap":
				// <value>[/<direction>] <uri> [<config>]
				fields := strings.Fields(attrVal)
				if len(fields) >= 2 {
					ext := MediaExt{uri: fields[1]}
					valDir := strings.Split(fields[0], "/")
					ext.value, _ = strconv.Atoi(valDir[0])
					if len(valDir) == 2 {
						ext.direction = valDir[1]
					}
					if len(fields) >= 3 {
						ext.config = fields[2]
					}
					m.ext = append(m.ext, ext)
				}
			}
}

func parseMedia(baseSDP string) ([]Media, error) {
	if !strings.Contains(baseSDP, "m=") {
        baseSDP = "m=audio 9 UDP/TLS/RTP/SAVPF 0\n" + baseSDP
    }

	lines := strings.Split(baseSDP, "\n")
	var mediaList []Media
	currentMedia := &Media{typ: "session"}

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) < 2 {
			continue
		}

		key := parts[0]
		val := parts[1]

		switch key {
			case "m":
				if currentMedia != nil && (currentMedia.typ != "session" || len(currentMedia.fingerprint) > 0) {
					mediaList = append(mediaList, *currentMedia)
				}
				currentMedia = &Media{}

				//m=<type> <port> <proto> <fmt>...
				mParts := strings.Fields(val)
				if len(mParts) >= 3 {
					currentMedia.typ = mParts[0]
					currentMedia.protocol = mParts[2]
					if len(mParts) >= 4 {
						currentMedia.payloads, _ = strconv.Atoi(mParts[3])
					}
				}
			
			case "a":
				parseAttribute(val, currentMedia)
			
			case "b":
				if currentMedia != nil {
					//b=<type>:<limit>
					bParts := strings.SplitN(val, ":", 2)
					if len(bParts) == 2 {
						limit, _ := strconv.Atoi(bParts[1])
						currentMedia.bandwidth = append(currentMedia.bandwidth, MediaBandwidth{
							typ: bParts[0],
							limit: limit,
						})
					}
				}
		}
	}

	if currentMedia != nil {
		mediaList = append(mediaList, *currentMedia)
	}

	return mediaList, nil
}

func makeSDP(mediaList []Media) string {
	var b strings.Builder

	b.WriteString("v=0\r\n")
	b.WriteString("o=- 1420070400000 0 IN IP4 127.0.0.1\r\n")
	b.WriteString("s=OLDCORDV4\r\n")
	b.WriteString("t=0 0\r\n")

	var mids []string

	for _, m := range mediaList {
		if m.mid != "" {
			mids = append(mids, m.mid)
		}
	}

	if len(mids) > 0 {
		b.WriteString(fmt.Sprintf("a=group:BUNDLE %s\r\n", strings.Join(mids, " ")))
	}

	b.WriteString("a=msid-semantic: WMS *\r\n")

	for _, m := range mediaList {
		b.WriteString(fmt.Sprintf("m=%s 9 %s %d\r\n", m.typ, m.protocol, m.payloads))

		//all this other bullshit...
		if m.mid != "" {
			b.WriteString(fmt.Sprintf("a=mid:%s\r\n", m.mid))
		}

		if m.setup != "" {
			b.WriteString(fmt.Sprintf("a=setup:%s\r\n", m.setup))
		}

		if m.rtcpMux != "" {
			b.WriteString("a=rtcp-mux\r\n")
		}

		if m.direction != "" {
			b.WriteString(fmt.Sprintf("a=%s\r\n", m.direction))
		}

		if m.msid != "" {
			b.WriteString(fmt.Sprintf("a=msid:%s\r\n", m.msid))
		}

		if m.fingerprint != "" {
   		 	b.WriteString(fmt.Sprintf("a=fingerprint:%s\r\n", m.fingerprint))
		}

		if m.iceUfrag != "" {
			b.WriteString(fmt.Sprintf("a=ice-ufrag:%s\r\n", m.iceUfrag))
		}

		if m.icePwd != "" {
			b.WriteString(fmt.Sprintf("a=ice-pwd:%s\r\n", m.icePwd))
		}

		// rtp mapping
		for _, rtp := range m.rtp {
			line := fmt.Sprintf("a=rtpmap:%d %s/%d", rtp.payload, rtp.codec, rtp.rate)

			if rtp.encoding > 0 {
				line += fmt.Sprintf("/%d", rtp.encoding)
			}

			b.WriteString(line + "\r\n")
		}

		// fmtp
		for _, f := range m.fmtp {
			b.WriteString(fmt.Sprintf("a=fmtp:%d %s\r\n", f.payload, f.config))
		}

		// rtcp feedback
		for _, fb := range m.rtcpFb {
			line := fmt.Sprintf("a=rtcp-fb:%s %s", fb.payload, fb.typ)

			if fb.subtype != "" {
				line += " " + fb.subtype
			}

			b.WriteString(line + "\r\n")
		}

		// ext maps
		for _, ext := range m.ext {
			line := fmt.Sprintf("a=extmap:%d", ext.value)

			if ext.direction != "" {
				line += "/" + ext.direction
			}

			line += " " + ext.uri

			if ext.config != "" {
				line += " " + ext.config
			}

			b.WriteString(line + "\r\n")
		}

		//ssrcs
		for _, ssrc := range m.ssrcs {
			line := fmt.Sprintf("a=ssrc:%d %s", ssrc.id, ssrc.attribute)

			if ssrc.value != "" {
				line += ":" + ssrc.value
			}

			b.WriteString(line + "\r\n")
		}
        
		for _, bw := range m.bandwidth {
			b.WriteString(fmt.Sprintf("b=%s:%d\r\n", bw.typ, bw.limit))
		}
	}

	return b.String()
}

func makeMedia(mid string, typ string, setup string, direction string, baseSDP string, payload int, bitrate int, ssrcs []SSRC) Media {
	baseMediaList, _ := parseMedia(baseSDP)

	var template Media
	for _, m := range baseMediaList {
		if m.typ == typ {
			template = m
			break
		}
	}

	m := Media{
		typ:       typ,
		protocol:  template.protocol,
		payloads:  payload,
		setup:     setup,
		mid:       mid,
		direction: direction,
		rtcpMux:   "rtcp-mux",
		ssrcs:     ssrcs,
		fingerprint: template.fingerprint,
        iceUfrag:    template.iceUfrag,
        icePwd:      template.icePwd,
	}

	for _, r := range template.rtp {
		if r.payload == payload {
			m.rtp = append(m.rtp, r)
		}
	}
	for _, f := range template.fmtp {
		if f.payload == payload {
			m.fmtp = append(m.fmtp, f)
		}
	}
	for _, fb := range template.rtcpFb {
		if fb.payload == strconv.Itoa(payload) || fb.payload == "*" {
			m.rtcpFb = append(m.rtcpFb, fb)
		}
	}

	if bitrate > 0 {
		m.bandwidth = append(m.bandwidth, MediaBandwidth{
			typ:   "AS",
			limit: bitrate,
		})
	}

	m.ext = template.ext

	return m
}

func generateSessionDescription(isFirefox bool, sdpType string, baseSDP string, direction string, audioPayload int, audioBitrate int, videoPayload int, videoBitrate int, remoteSSRCs []RemoteSSRC) string {
	if strings.Contains(baseSDP, "v=") {
		return baseSDP
	} //full SDP - legacy offer/answer system

	var mediaList []Media
	setup := "active" //actpass

	if sdpType == "answer" {
		setup = "passive"
	}

	if isFirefox {
		//unified plan - each ssrc has its own m= section with an mid like sdparta_5 billion

		if len(remoteSSRCs) == 0 {
			mediaList = append(mediaList, makeMedia("0", "audio", setup, direction, baseSDP, audioPayload, audioBitrate, []SSRC{}))
		} //fallback on 0 media tracks

		for i, s := range remoteSSRCs {
			mid := fmt.Sprintf("%d", i)
			payload := audioPayload
			bitrate := audioBitrate
			sentinel := "a"

			if s.Typ == "video" {
				payload = videoPayload
				bitrate = videoBitrate
				sentinel = "v"
			}

			dir := direction

			if !s.Active {
				dir = "inactive"
			}

			ssrcAttrs := makeSSRC(s.CName, s.SSRC, sentinel)
			mediaList = append(mediaList, makeMedia(mid, s.Typ, setup, dir, baseSDP, payload, bitrate, ssrcAttrs))
		}
	} else {
		//plan-b (deprecated - but wasnt in 2017 in the reference client code):
		//all audio ssrcs are in one single m=audio line, all video ssrcs are the same but for m=video. makes sense? ok

		var audioSSRCs []SSRC
		var videoSSRCs []SSRC

		for _,s := range remoteSSRCs {
			if !s.Active {
				continue
			}

			if s.Typ == "audio" {
				audioSSRCs = append(audioSSRCs, makeSSRC(s.CName, s.SSRC, "a")...)
			} else {
				videoSSRCs = append(videoSSRCs, makeSSRC(s.CName, s.SSRC, "v")...)
			}
		}

		mediaList = append(mediaList, makeMedia("audio", "audio", setup, direction, baseSDP, audioPayload, audioBitrate, audioSSRCs))
		mediaList = append(mediaList, makeMedia("video", "video", setup, direction, baseSDP, videoPayload, videoBitrate, videoSSRCs))
	}

	return makeSDP(mediaList)
}

func makeAnswer(localSDP string, serverIP string, serverPort int, legacyAnswer bool) string {
	if legacyAnswer {
		return localSDP
	}

	medias, _ := parseMedia(localSDP)

	if len(medias) == 0 {
		return "" //Something went wrong.. uh??
	}

	var iceUfrag, icePwd, fingerprint string
    var candidateLine string

	for _, m := range medias {
        if m.fingerprint != "" {
            fingerprint = m.fingerprint
        }
        if m.iceUfrag != "" {
            iceUfrag = m.iceUfrag
            icePwd = m.icePwd
        }
        if len(m.candidates) > 0 && candidateLine == "" {
            candidateLine = m.candidates[0]
        }
    }

    // (2=transport, 3=foundation, 4=address, 5=port)

    cParts := strings.Fields(candidateLine)
    transport := "UDP"
    addr := serverIP
    port := strconv.Itoa(serverPort)

    if len(cParts) >= 8 {
        transport = cParts[2]
        addr = cParts[4]
        port = cParts[5]
    }

    var b strings.Builder
	
    b.WriteString(fmt.Sprintf("m=audio %d ICE/SDP\n", serverPort))
    b.WriteString(fmt.Sprintf("a=fingerprint:%s\n", fingerprint))
    b.WriteString(fmt.Sprintf("c=IN IP4 %s\n", serverIP))
    b.WriteString(fmt.Sprintf("a=rtcp:%d\n", serverPort))
    b.WriteString(fmt.Sprintf("a=ice-ufrag:%s\n", iceUfrag))
    b.WriteString(fmt.Sprintf("a=ice-pwd:%s\n", icePwd))
    b.WriteString(fmt.Sprintf("a=candidate:1 1 %s 2122260223 %s %s typ host\n", transport, addr, port))

    return b.String()
}