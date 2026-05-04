import { Router } from 'express';
import type { Response, Request } from "express";
import { getRegions } from '../helpers/globalutils.js';
import { cacheForMiddleware } from '../helpers/middlewares.ts';
import { CodecInfo, MediaInfo, SDPInfo } from "semantic-sdp";
import { logText } from '../helpers/logger.ts';
import errors from '../helpers/errors.ts';

const router = Router({ mergeParams: true });

function handleOffer(sdpOffer: string, codecs: any[]) {
    const offer = sdpOffer.startsWith("v=0") ? SDPInfo.parse(sdpOffer): SDPInfo.parse("m=audio\n" + sdpOffer);

    const rtpHeaders = new Map(offer.medias[0].extensions);

    const getIdForHeader = (rtpHeaders: any, headerUri: any) => {
        for (const [key, value] of rtpHeaders) {
            if (value == headerUri) return key;
        }
        return -1;
    };

    const isChromium = codecs.find((val) => val.name == "opus")?.payload_type === 111;

    const audioMedia = new MediaInfo("0", "audio");
    const audioCodec = new CodecInfo(
        "opus",
        codecs.find((val) => val.name == "opus")?.payload_type ?? 111,
    );
    audioCodec.addParam("minptime", "10");
    audioCodec.addParam("usedtx", "1");
    audioCodec.addParam("useinbandfec", "1");
    audioCodec.setChannels(2);
    audioMedia.addCodec(audioCodec);

    const audioLevelExtensionId = getIdForHeader(
        rtpHeaders,
        "urn:ietf:params:rtp-hdrext:ssrc-audio-level",
    );

    if (audioLevelExtensionId > -1) {
        audioMedia.addExtension(
            audioLevelExtensionId,
            "urn:ietf:params:rtp-hdrext:ssrc-audio-level",
        );
    }

    if (isChromium) {
        // if this is chromium, apply this header
        const transportWideCcHeaderId = getIdForHeader(
            rtpHeaders,
            "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
        );
        if (transportWideCcHeaderId > -1) {
            audioMedia.addExtension(
                transportWideCcHeaderId,
                "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
            );
        }
    }

    const videoMedia = new MediaInfo("1", "video");

    const videoCodec = new CodecInfo(
        "H264",
        codecs.find((val) => val.name == "H264")?.payload_type ?? 102,
    );
    videoCodec.setRTX(
        codecs.find((val) => val.name == "H264")?.rtx_payload_type ?? 103,
    );
    videoCodec.addParam("level-asymmetry-allowed", "1");
    videoCodec.addParam("packetization-mode", "1");
    videoCodec.addParam("profile-level-id", "42e01f");
    videoCodec.addParam("x-google-max-bitrate", "2500");
    videoMedia.addCodec(videoCodec);

    const absSendTimeHeaderId = getIdForHeader(
        rtpHeaders,
        "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
    );
    if (absSendTimeHeaderId > -1) {
        videoMedia.addExtension(
            absSendTimeHeaderId,
            "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
        );
    }
    const toffsetHeaderId = getIdForHeader(rtpHeaders, "urn:ietf:params:rtp-hdrext:toffset");
    if (toffsetHeaderId > -1) {
        videoMedia.addExtension(
            toffsetHeaderId,
            "urn:ietf:params:rtp-hdrext:toffset",
        );
    }
    const playoutDelayHeaderId = getIdForHeader(
        rtpHeaders,
        "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
    );
    if (playoutDelayHeaderId > -1) {
        videoMedia.addExtension(
            playoutDelayHeaderId,
            "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
        );
    }
    const transportWideCcHeaderId = getIdForHeader(
        rtpHeaders,
        "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
    );
    if (transportWideCcHeaderId > -1) {
        videoMedia.addExtension(
            transportWideCcHeaderId,
            "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
        );
    }

    if (isChromium) {
        // if this is chromium, apply this header
        const videoOrientationHeaderId = getIdForHeader(rtpHeaders, "urn:3gpp:video-orientation");
        if (videoOrientationHeaderId > -1) {
            videoMedia.addExtension(
                videoOrientationHeaderId,
                "urn:3gpp:video-orientation",
            );
        }
    }

    offer.medias = [audioMedia, videoMedia];

    const finalOffer = offer.toString().replace(" NaN ", " 3984 ").replace(":actpass", ":active");

    return finalOffer;
}

router.get('/regions', cacheForMiddleware(60 * 60 * 5, "private", false), async (_req: Request, res: Response) => {
  return res.status(200).json(getRegions());
});

router.get('/ice', (_req: Request, res: Response) => {
  return res.status(200).json({
    servers: [
      {
        url: 'stun:stun.l.google.com:19302',
        username: '',
        credential: '',
      },
    ],
  });
});

router.post("/process-offer", (req, res) => {
    try {
        const { sdpFragment, codecs } = req.body;
        const finalOffer = handleOffer(sdpFragment, codecs);

        return res.status(200).send(finalOffer);
    } catch (err: any) {
        logText(err, 'error');
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
});

router.post("/process-answer", (req, res) => {
    try {
        const { pionSdp, publicIp, publicPort, fingerprint } = req.body;
        const answerSdp = SDPInfo.parse(pionSdp);
        const candidate = answerSdp.candidates[0];
        const answer =
            `m=audio ${publicPort} ICE/SDP\n` +
            `a=fingerprint:${fingerprint}\n` +
            `c=IN IP4 ${publicIp}\n` +
            `a=rtcp:${publicPort}\n` +
            `a=ice-ufrag:${answerSdp.ice.getUfrag()}\n` +
            `a=ice-pwd:${answerSdp.ice.getPwd()}\n` +
            //`a=fingerprint:${fingerprint}\n` +
            `a=candidate:1 1 ${candidate.getTransport()} ${candidate.getFoundation()} ${candidate.getAddress()} ${candidate.getPort()} typ host\n`;

        return res.status(200).send(answer);
    } catch (err: any) {
        logText(err, 'error');
        return res.status(500).json(errors.response_500.INTERNAL_SERVER_ERROR);
    }
});

export default router;