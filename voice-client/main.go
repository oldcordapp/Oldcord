package main

const rtcServerURL = "ws://127.0.0.1:3240"
const opusOggFile = "test.ogg"

func main() {
	go NewVoiceClient(rtcServerURL, "udp", "12345", "1499572053584388105", "67890", "session_abc1", "token_xyz1", true)
	go NewVoiceClient(rtcServerURL, "udp", "1499572053563416582", "1499572053584388105", "1000", "93933", "aaaaa", false)

	select {}
}

//ffmpeg -i test.ogg -c:a libopus -page_duration 20000 -f opus test-opus.ogg