package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"time"

	"github.com/pion/rtp"
)

type OggHeader struct {
	CapturePattern []byte //Offset 0 -> 4 bytes
	Version uint8 //Offset 4 -> 1 byte
	HeaderType uint8 //Offset 5 -> 1 byte
	GranulePosition uint64 //Offset 6 -> 8 bytes
	BitstreamSerialNumber uint32 //Offset 14 -> 4 bytes
	PageSequenceNumber uint32 //Offset 18 -> 4 bytes
	Checksum uint32 //Offset 22 -> 4 bytes
	NumSegments uint8 //Offset 26 -> 1 byte
}

type OggPage struct {
	Header *OggHeader //Offset 0 -> 27 bytes
	SegmentTable []uint8 // Offset 27 -> ?? bytes (determined by number segments) - it's all 1 byte entries
	AudioData []byte //Offset ?? -> ?? bytes
}

type OggFile struct {
	Pages []OggPage
}

type VorbisPacket struct {
	Packet []byte
}

type OpusPacket struct {
	Packet []byte
}

func ParseHeader(header []byte) *OggHeader {
	if !bytes.Equal(header[:4], []byte("OggS")) {
		return nil
	}

	return &OggHeader{
		CapturePattern: header[:4],
		Version: header[4],
		HeaderType: header[5],
		GranulePosition: binary.LittleEndian.Uint64(header[6:14]),
		BitstreamSerialNumber: binary.LittleEndian.Uint32(header[14:18]),
		PageSequenceNumber: binary.LittleEndian.Uint32(header[18:22]),
		Checksum: binary.LittleEndian.Uint32(header[22:26]),
		NumSegments: header[26],
	}
}

func ParseOgg(rawData []byte) *OggFile {
	file := &OggFile{}
	offset := 0

	for offset < len(rawData) {
		if offset+27 > len(rawData) {
			break
		} //missing header

		header := ParseHeader(rawData[offset : offset+27])

		if header == nil {
			break
		}

		offset += 27 //add header onto cursor

		segmentsCount := int(header.NumSegments)

		if offset + segmentsCount > len(rawData) {
			break
		} //no segments table in ogg page

		segmentTable := rawData[offset : offset+segmentsCount]
		offset += segmentsCount

		payloadTotal := 0

		for _, s := range segmentTable {
			payloadTotal += int(s)
		}

		if offset + payloadTotal > len(rawData) {
			break
		} //data is corrupt

		data := rawData[offset : offset + payloadTotal]
		offset += payloadTotal

		page := OggPage{
			Header: header,
			SegmentTable: segmentTable,
			AudioData: data,
		}

		file.Pages = append(file.Pages, page)
	}
	
	return file
}

func ReadOpusPackets(file *OggFile) []OpusPacket {
	var opus []OpusPacket
	var packet []byte

	for _, page := range file.Pages {
		offset := 0

		for _, segLen := range page.SegmentTable {

			packet = append(packet,
				page.AudioData[offset:offset+int(segLen)]...,
			)

			offset += int(segLen)

			if segLen < 255 {
				opus = append(opus, OpusPacket{
					Packet: packet,
				})

				packet = nil
			}
		}
	}

	if len(packet) > 0 {
		opus = append(opus, OpusPacket{
			Packet: packet,
		})
	}

	return opus
}

func ReadVorbisPackets(file *OggFile) []VorbisPacket {
	var vorbis []VorbisPacket
	var packet []byte

	for _, page := range file.Pages {
		offset := 0

		for _, len := range page.SegmentTable {
			packet = append(packet, page.AudioData[offset : offset + int (len)]...)

			offset += int(len)

			if len < 255 {
				vorbis = append(vorbis, VorbisPacket{
					Packet: packet,
				})

				packet = nil
			}
		}
	}

	return vorbis
}

func StreamFromOpusPackets(conn *net.UDPConn, addr *net.UDPAddr, packets []OpusPacket, ssrc uint32, payloadType uint8) {
	var seq uint16
	var timestamp uint32
	
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()

	offset := 0

	for range ticker.C {
		if offset >= len(packets) {
			return
		} //done streaming

		packet := packets[offset]

		rtpPacket := rtp.Packet{
			Header: rtp.Header{
				Version: 2,
				PayloadType: payloadType,
				SequenceNumber: seq,
				Timestamp: timestamp,
				SSRC: ssrc,
			},
			Payload: packet.Packet,
		}

		rawUDP, _ := rtpPacket.Marshal()
		conn.WriteToUDP(rawUDP, addr)

		seq++
		timestamp += 960
		offset++
	}
}

func ToRTPPacketFromVorbis(packets []VorbisPacket) {
	//to-do
}

func ReadOggFromFile(path string) *OggFile {
	file, err := os.Open(path)
    if err != nil {
        fmt.Printf("File error: %v\n", err)
        return nil
    }
    defer file.Close()

	data, err := io.ReadAll(file)

	if err != nil {
		return nil
	}

	oggFile := ParseOgg(data)
	
	if oggFile == nil {
		fmt.Println("Failed to read ogg file")
		return nil
	}

	return oggFile
}