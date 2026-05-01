export default {
  target: 'all',
  name: 'Modernize WebRTC',
  description:
    'Adds legacy WebRTC compatibility patches including SDP fixes and unified-plan workarounds.',
  authors: ['Oldcord Team'],
  mandatory: false,
  configurable: true,
  defaultEnabled: true,
  compatibleBuilds: 'all',
  incompatiblePlugins: ['forceWebRtcP2P'],
  debug: false,

  patches: [
    {
      find: /RTCPeerConnection|_generateSessionDescription|selectProtocol|sdparta_/,
      replacement: [
        {
          global: true,
          match: `l(e,t,n,a,i,(r||4e4)/1e3)`,
          replace: `window.oldcord.fixSessionDescription2016(e,t,n,a,i,(r||4e4)/1e3)`,
        },
        {
          global: true,
          match: `e.selectProtocol(a,r)`,
          replace: `e.selectProtocol(a,window.oldcord.truncateSDP(r))`,
        },
        {
          global: true,
          match: `^a=ice|opus|VP8`,
          replace: `^a=ice|a=extmap|a=fingerprint|opus|VP8`,
        },
        {
          global: true,
          match: `^a=ice|opus|VP9`,
          replace: `^a=ice|a=extmap|a=fingerprint|opus|VP9`,
        },
        {
          global: true,
          match:
            't.prototype._generateSessionDescription=function(e){var t=this.audioCodec,n=this.audioPayloadType,o=this.videoCodec,a=this.videoPayloadType,r=this.rtxPayloadType,i=this.sdp;if(null==t||null==n||null==o||null==a||null==r||null==i)throw new Error("payload cannot be null");var s=this._getSSRCs(),u=(0,c.generateSessionDescription)(e,i,this.direction,t,n,40,o,a,2500,r,s);return this.emit(e,u),Promise.resolve(u)}',
          replace:
            't.prototype._generateSessionDescription=function(e){var t=this;return"answer"===e?this._pc._pc.createAnswer().then(function(e){return t.emit("answer",e),e}):this._pc._pc.createOffer().then(function(e){return t.emit("offer",e),e})}',
        },
        {
          global: true,
          match:
            /new\s+RTCPeerConnection\s*\(({\s*iceServers\s*:\s*\w+\s*})\s*,\s*{\s*optional\s*:\s*\[\s*{\s*DtlsSrtpKeyAgreement\s*:\s*(?:!0|true)\s*}\s*]\s*}\)/g,
          replace: 'new RTCPeerConnection($1)',
        },
        {
          global: true,
          match: `{mandatory:{OfferToReceiveAudio:!0,OfferToReceiveVideo:!1},optional:[{VoiceActivityDetection:!0}]};`,
          replace: `{OfferToReceiveAudio:!0,OfferToReceiveVideo:!1};`,
        },
        {
          global: true,
          match:
            /(var \w+=(\w+)\._pc=new RTCPeerConnection\({iceServers:\w+,sdpSemantics:)"plan-b"(.+?\);)/g,
          replace:
            '$1"unified-plan"$3$2._audioTransceiver=$2._pc.addTransceiver("audio",{direction:"recvonly"});$2._videoTransceiver=$2._pc.addTransceiver("video",{direction:"recvonly"});',
        },
        {
          global: true,
          match:
            /case"video":[a-zA-Z]\(function\(\)\{return t\._handleVideo\(t\.input\.getVideoStreamId\(\)\)\}\);break;/g,
          replace: `case"video":(async()=>{while(!t._fpc||!t._fpc._connected)await new Promise(e => setTimeout(e,50));t._handleVideo(t.input.getVideoStreamId())})();break;`,
        },
        {
          global: true,
          match:
            /[a-zA-Z]\(function\(\)\{return t\._handleVideo\(t\.input\.getVideoURL\(\)\)\}\);/g,
          replace: `(async()=>{while(!t._fpc||!t._fpc._connected)await new Promise(e=>setTimeout(e,50));t._handleVideo(t.input.getVideoURL())})();`,
        },
        {
          global: true,
          match: `this._mute||!this._speaking`,
          replace: `this._mute`,
        },
        {
          global: true,
          match: `this._mute||this._speakingFlags===s.SpeakingFlags.NONE`,
          replace: `this._mute`,
        },
        {
          global: true,
          match: `.src=URL.createObjectURL(this._stream)`,
          replace: `.srcObject=this._stream`,
        },
        {
          global: true,
          match: `"sdparta_"+`,
          replace: ``,
        },
        {
          global: true,
          match: `sdparta_`,
          replace: ``,
        },
        {
          global: true,
          match: `URL.revokeObjectURL(this._audioElement.src))`,
          replace: `this._audioElement.srcObject = null)`,
        },
      ],
    },
  ],

  start() {
    if (!window.oldcord) window.oldcord = {};
    if (!window.oldcord.webRTCPatch) window.oldcord.webRTCPatch = {};
    if (window.oldcord.webRTCPatch.isPatched) return;

    if (!window.oldcord.truncateSDP) {
      window.oldcord.truncateSDP = function (sdp) {
        const filterRegex = new RegExp('^a=ice|a=extmap|a=fingerprint|opus|VP8|0 rtx', 'i');
        const lines = sdp.split(/\r\n|\n/);
        const filteredLines = lines.filter((line) => filterRegex.test(line));
        const uniqueLines = [...new Set(filteredLines)];
        return uniqueLines.join('\n');
      };
    }

    if (!window.oldcord.fixSessionDescription2016) {
      window.oldcord.fixSessionDescription2016 = function (
        type,
        audioPayloadType,
        sdp,
        direction,
        unknown,
        bitrate = 6400 / 100,
      ) {
        function replaceSDP(source, payloadType) {
          return source.replace(`ICE/SDP`, `RTP/SAVPF ` + payloadType).trim();
        }

        const defaults = [0, 'default', !0];
        sdp = replaceSDP(sdp, audioPayloadType);
        unknown = [defaults].concat(unknown);

        const formattedUnknown = unknown
          .map(function (_e, t) {
            return t;
          })
          .join(' ');

        const u = unknown.map(function (e, t) {
          const i = e[0];
          const r = e[1];
          const s = e[2];
          return s
            ? sdp +
                '\na=' +
                (direction === 'sendrecv' && t === 0 ? 'sendrecv' : 'sendonly') +
                '\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\na=mid:' +
                t +
                '\nb=AS:' +
                bitrate +
                '\na=msid:' +
                r +
                '-' +
                i +
                ' ' +
                r +
                '-' +
                i +
                '\na=rtcp-mux\na=rtpmap:' +
                audioPayloadType +
                ' opus/48000/2\na=setup:actpass\na=ssrc:' +
                i +
                ' cname:' +
                r +
                '-' +
                i
            : 'm=audio 0 RTP/SAVPF ' +
                audioPayloadType +
                '\nc=IN IP4 0.0.0.0\na=inactive\na=rtpmap:' +
                audioPayloadType +
                ' NULL/0';
        });

        return (
          [
            'v=0\no=- 6054093392514871408 0 IN IP4 127.0.0.1\ns=-\nt=0 0\na=group:BUNDLE ' +
              formattedUnknown +
              '\na=msid-semantic:WMS *',
          ]
            .concat(u)
            .join('\n')
            .trim() + '\n'
        );
      };
    }

    window.oldcord.webRTCPatch.isPatched = true;
    window.oldcord.webRTCPatch.previousDescription = new WeakMap();

    const originalSetLocalDescription = RTCPeerConnection.prototype.setLocalDescription;
    const originalSetRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription;

    const getHeader = (sdp) => sdp.split('\r\nm=')[0];
    const getMediaBlocks = (sdp) => {
      const parts = sdp.split(/\r?\nm=/);
      return parts.length > 1 ? parts.slice(1).map((block) => 'm=' + block.trim()) : [];
    };
    const getMediaType = (block) => (block.match(/^m=(\w+)/) || [])[1];
    const getDirection = (block) =>
      (block.match(/a=(sendrecv|sendonly|recvonly|inactive)/) || [])[0];

    const parseExtmaps = (mediaBlock) => {
      const extmaps = new Map();
      const lines = mediaBlock.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^a=extmap:(\d+)\s+(.*)$/);
        if (match) {
          const id = parseInt(match[1], 10);
          const uri = match[2].trim();
          extmaps.set(uri, id);
        }
      }
      return extmaps;
    };

    RTCPeerConnection.prototype.setLocalDescription = function (description) {
      if (description) {
        window.oldcord.webRTCPatch.previousDescription.set(this, description);
      }
      return originalSetLocalDescription.apply(this, arguments);
    };

    if (
      release_date.includes('_2016') ||
      release_date.includes('_2015') ||
      release_date === 'january_23_2017'
    ) {
      return;
    }

    RTCPeerConnection.prototype.setRemoteDescription = async function (description) {
      if (!/Chrome/.test(navigator.userAgent) || !description) {
        if (description) {
          window.oldcord.webRTCPatch.previousDescription.set(this, description);
        }
        return originalSetRemoteDescription.apply(this, arguments);
      }

      const previousDescription = window.oldcord.webRTCPatch.previousDescription.get(this);
      if (!previousDescription) {
        console.warn('[SDP Patcher] No corresponding description found. Applying answer as-is.');
        window.oldcord.webRTCPatch.previousDescription.set(this, description);
        return originalSetRemoteDescription.apply(this, arguments);
      }

      const previousMBlocks = getMediaBlocks(previousDescription.sdp);
      const currentMBlocks = getMediaBlocks(description.sdp);

      if (currentMBlocks.length === 0) {
        console.error('[SDP Patcher] The description has no media blocks.');
        return originalSetRemoteDescription.apply(this, arguments);
      }

      if (previousMBlocks.length > currentMBlocks.length) {
        console.log(
          `[SDP Patcher] Offer/Answer m-block mismatch (${previousMBlocks.length} > ${currentMBlocks.length}). Adding missing sections.`,
        );

        for (let i = currentMBlocks.length; i < previousMBlocks.length; i++) {
          const missingMBlock = previousMBlocks[i];
          const missingMediaType = getMediaType(missingMBlock);

          const templateBlock =
            currentMBlocks.find((b) => getMediaType(b) === missingMediaType) || currentMBlocks[0];
          const newBlockLines = templateBlock.split(/\r?\n/);

          const previousMDirection = getDirection(missingMBlock);
          let currentMDirection = previousMDirection;
          if (previousMDirection === 'a=sendonly') {
            currentMDirection = 'a=recvonly';
          } else if (previousMDirection === 'a=recvonly') {
            currentMDirection = 'a=sendonly';
          }

          const directionIndex = newBlockLines.findIndex((line) =>
            line.match(/a=(sendrecv|sendonly|recvonly|inactive)/),
          );
          if (directionIndex > -1 && currentMDirection) {
            newBlockLines[directionIndex] = currentMDirection;
          } else if (currentMDirection) {
            newBlockLines.push(currentMDirection);
          }

          newBlockLines[0] = newBlockLines[0].replace(/^m=\w+/, `m=${missingMediaType}`);
          currentMBlocks.push(newBlockLines.join('\r\n'));
        }
      }

      const fixedMBlocks = currentMBlocks.map((answerBlock, index) => {
        const offerBlock =
          previousMBlocks.find((b) => getMediaType(b) === getMediaType(answerBlock)) ||
          previousMBlocks[index];

        if (!offerBlock) return answerBlock;

        const offerExtmaps = parseExtmaps(offerBlock);
        if (offerExtmaps.size === 0) return answerBlock;

        const answerLines = answerBlock.split(/\r?\n/);
        const newAnswerLines = [];

        for (const line of answerLines) {
          if (line.startsWith('a=extmap:')) {
            const match = line.match(/^a=extmap:(\d+)\s+(.*)$/);
            if (match) {
              const answerUri = match[2].trim();
              if (offerExtmaps.has(answerUri)) {
                const correctId = offerExtmaps.get(answerUri);
                newAnswerLines.push(`a=extmap:${correctId} ${answerUri}`);
              } else {
                console.warn(`[SDP Patcher] Discarding unsupported extmap from answer: ${line}`);
              }
            }
          } else {
            newAnswerLines.push(line);
          }
        }
        return newAnswerLines.join('\r\n');
      });

      const sdpHeader = getHeader(description.sdp);
      let finalSdp = sdpHeader + '\r\n' + fixedMBlocks.join('\r\n');

      let midIndex = 0;
      finalSdp = finalSdp.replace(/^a=mid:.*$/gm, () => `a=mid:${midIndex++}`);

      const midCount = (finalSdp.match(/^m=/gm) || []).length;
      if (midCount > 0) {
        const newMidList = Array.from({ length: midCount }, (_, i) => i).join(' ');
        if (finalSdp.includes('a=group:BUNDLE')) {
          finalSdp = finalSdp.replace(/^a=group:BUNDLE.*$/gm, `a=group:BUNDLE ${newMidList}`);
        }
      }

      finalSdp = finalSdp.replace(/(\r?\n){2,}/g, '\r\n').trim() + '\r\n';

      finalSdp = 'v=0' + finalSdp.split('v=0').pop();

      const newDescription = new RTCSessionDescription({
        type: 'answer',
        sdp: finalSdp,
      });

      console.log('[SDP Patcher] Original Answer SDP:\n', description.sdp);
      console.log('[SDP Patcher] Modified Answer SDP:\n', newDescription.sdp);

      window.oldcord.webRTCPatch.previousDescription.set(this, description);
      return originalSetRemoteDescription.call(this, newDescription);
    };
  },
};