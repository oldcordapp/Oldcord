import { utils } from './utils.js';

function getEnabledPatches() {
  const cookie = document.cookie.split('; ').find((row) => row.startsWith('enabled_patches='));
  if (!cookie) return [];
  try {
    return JSON.parse(decodeURIComponent(cookie.split('=')[1]));
  } catch {
    return [];
  }
}

const patcher = {
  css(css) {
    css = css
      .replaceAll(/d3dsisomax34re.cloudfront.net/g, location.host)
      .replaceAll(/url\(\/assets\//g, `url(${assets_cdn_url}/assets/`);

    // User select patch for 2015 if enabled
    if (getEnabledPatches().includes('userSelect') && release_date.endsWith('_2015')) {
      css = css.replaceAll(
        /-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;/g,
        '',
      );
      css = css.replaceAll(/-webkit-user-select:none;/g, '');
      css = css.replaceAll(/user-select:none;/g, '');
      css = css.replaceAll(/-moz-user-select:none;/g, '');
      css = css.replaceAll(/-ms-user-select:none;/g, '');
    }

    css += '\n/* Oldcord Patched */';
    return css;
  },

  js(script, kind, config) {
    function escapeRegExp(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
    }

    // Fix client misidentification
    script = script.replace('__[STANDALONE]__', '');

    script = script.replace(`c["default"].createSessionDescription(e,this.payloadType,this.remoteSDP,t,n,this.bitrate)`, `new RTCSessionDescription({type:e,sdp:this.remoteSDP})`); //fix 2016 sdp handling - theres no munging, no plan-b, so simple in 2015-2016, its beautiful
    script = script.replace(`.src=URL.createObjectURL`, `.srcObject=`) //fix webrtc audio playback deprecation on 2015-2016
    script = script.replace(`d(e,t,n,o,r)`, `n`) //fix sdp munging on 2015, other than that the existing code is unified-plan compliant. its beautiful. why the fuck did you mess up 2017 :sob:

    // Recaptcha support
    if (config.captcha_options.enabled)
      script = script.replaceAll(
        '6Lef5iQTAAAAAKeIvIY-DeexoO3gj7ryl9rLMEnn',
        config.captcha_options.site_key,
      );

    // Disable telemetry
    script = script.replace(/track:function\([^)]*\){/, '$&return;');
    script = script.replace(
      /(function \w+\(e\)){[^p]*post\({.*url:\w\.Endpoints\.TRACK[^}]*}\)}/,
      '$1{}',
    );
    script = script.replace(
      /(?:return\s+)?\w+(?:\.default|\["default"\])\.post\(\{[\s\S]*?url:\w+\.Endpoints\.TRACK[\s\S]*?\}\)(?:\.catch\(function\(\w\)\{[\s\S]*?\}\))?/g,
      'null;',
    );
    script = script.replace(
      /t\.analyticsTrackingStoreMaker=function\(e\){/,
      't.analyticsTrackingStoreMaker=function(e){return;',
    );

    if (!utils.isOldplungerEnabled()) {
      if (getEnabledPatches().includes('modernizeWebRTC')) {
        script = script.replaceAll(
          `l(e,t,n,a,i,(r||4e4)/1e3)`,
          `window.oldcord.fixSessionDescription2016(e,t,n,a,i,(r||4e4)/1e3)`,
        ); // i tried to get you to cooperate so this is what you get
        script = script.replaceAll(
          `e.selectProtocol(a,r)`,
          `e.selectProtocol(a,window.oldcord.truncateSDP(r))`,
        ); //Jan 23 2017
        script = script.replaceAll(`^a=ice|opus|VP8`, `^a=ice|a=extmap|a=fingerprint|opus|VP8`); //2017-2018 fix
        script = script.replaceAll(`^a=ice|opus|VP9`, `^a=ice|a=extmap|a=fingerprint|opus|VP9`); //2017-2018 fix
        script = script.replaceAll(
          't.prototype._generateSessionDescription=function(e){var t=this.audioCodec,n=this.audioPayloadType,o=this.videoCodec,a=this.videoPayloadType,r=this.rtxPayloadType,i=this.sdp;if(null==t||null==n||null==o||null==a||null==r||null==i)throw new Error("payload cannot be null");var s=this._getSSRCs(),u=(0,c.generateSessionDescription)(e,i,this.direction,t,n,40,o,a,2500,r,s);return this.emit(e,u),Promise.resolve(u)}',
          't.prototype._generateSessionDescription=function(e){var t=this;return"answer"===e?this._pc._pc.createAnswer().then(function(e){return t.emit("answer",e),e}):this._pc._pc.createOffer().then(function(e){return t.emit("offer",e),e})}',
        ); //Not a necessary patch on 2018
        script = script.replaceAll(
          /new\s+RTCPeerConnection\s*\(({\s*iceServers\s*:\s*\w+\s*})\s*,\s*{\s*optional\s*:\s*\[\s*{\s*DtlsSrtpKeyAgreement\s*:\s*(?:!0|true)\s*}\s*]\s*}\)/g,
          'new RTCPeerConnection($1)',
        ); //2015 - first 2017 build fix
        script = script.replaceAll(
          `{mandatory:{OfferToReceiveAudio:!0,OfferToReceiveVideo:!1},optional:[{VoiceActivityDetection:!0}]};`,
          `{OfferToReceiveAudio:!0,OfferToReceiveVideo:!1};`,
        ); //2015 - first 2017 build fix
        script = script.replaceAll(
          /(var \w+=(\w+)\._pc=new RTCPeerConnection\({iceServers:\w+,sdpSemantics:)"plan-b"(.+?\);)/g,
          '$1"unified-plan"$3$2._audioTransceiver=$2._pc.addTransceiver("audio",{direction:"recvonly"});$2._videoTransceiver=$2._pc.addTransceiver("video",{direction:"recvonly"});',
        );
        script = script.replaceAll(
          /case"video":[a-zA-Z]\(function\(\)\{return t\._handleVideo\(t\.input\.getVideoStreamId\(\)\)\}\);break;/g,
          `case"video":(async()=>{while(!t._fpc||!t._fpc._connected)await new Promise(e => setTimeout(e,50));t._handleVideo(t.input.getVideoStreamId())})();break;`,
        ); //2017-2018
        script = script.replaceAll(
          /[a-zA-Z]\(function\(\)\{return t\._handleVideo\(t\.input\.getVideoURL\(\)\)\}\);/g,
          `(async()=>{while(!t._fpc||!t._fpc._connected)await new Promise(e=>setTimeout(e,50));t._handleVideo(t.input.getVideoURL())})();`,
        ); //very early 2017 fix
        script = script.replaceAll(`this._mute||!this._speaking`, `this._mute`); //2017 fix
        script = script.replaceAll(
          `this._mute||this._speakingFlags===s.SpeakingFlags.NONE`,
          `this._mute`,
        ); //2018

        // Rewrite setRemoteDescription to unified-plan based of current setLocalDescription's offer in a similar manner to modern Discord's
        (function () {
          if (window.oldcord && !window.oldcord.webRTCPatch) {
            window.oldcord.webRTCPatch = {};
          }

          if (window.oldcord.webRTCPatch.isPatched) {
            return;
          }

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
              function replaceSDP(sdp, audioPayloadType) {
                return sdp.replace(`ICE/SDP`, `RTP/SAVPF ` + audioPayloadType).trim();
              }

              const defaults = [0, 'default', !0];

              sdp = replaceSDP(sdp, audioPayloadType);
              unknown = [defaults].concat(unknown);

              const formattedUnknown = unknown
                .map(function (e, t) {
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
              console.warn(
                '[SDP Patcher] No corresponding description found. Applying answer as-is.',
              );
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
                  currentMBlocks.find((b) => getMediaType(b) === missingMediaType) ||
                  currentMBlocks[0];
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
                      console.warn(
                        `[SDP Patcher] Discarding unsupported extmap from answer: ${line}`,
                      );
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
        })();
      }

      if (getEnabledPatches().includes('forceWebRtcP2P')) {
        script = script.replaceAll(/.p2p=./g, `.p2p=true`);
      }

      script = script.replaceAll(
        `.src=URL.createObjectURL(this._stream)`,
        `.srcObject=this._stream`,
      ); //  deprecation for webrtc fix
      script = script.replaceAll(`"sdparta_"+`, ``); //firefox webrtc doesnt like non numeric values as mid
      script = script.replaceAll(`sdparta_`, ``);

      if (/Firefox/.test(navigator.userAgent)) {
        script = script.replaceAll(
          `URL.revokeObjectURL(this._audioElement.src))`,
          `this._audioElement.srcObject = null)`,
        ); //firefox is very finnicky about these
      }

      // Allow emojis anywhere if patch enabled
      if (getEnabledPatches().includes('emojiAnywhere')) {
        script = script.replace(/isEmojiDisabled:function\([^)]*\){/, '$&return false;');
        script = script.replaceAll(/=t.invalidEmojis/g, '=[]');
      }

      // Electron patches if enabled
      if (window.DiscordNative) {
        // Polyfilling Desktop Native API on <April 2018  (Not entirely complete!)
        if (
          release_date.endsWith('_2015') ||
          release_date.endsWith('_2016') ||
          release_date.endsWith('_2017') ||
          (release_date.endsWith('_2018') &&
            (release_date.startsWith('january') ||
              release_date.startsWith('february') ||
              release_date.startsWith('march')))
        ) {
          script = script.replace(
            /\/\^win\/\.test\(this\.platform\)/,
            '/^win/.test(window.DiscordNative.process.platform)',
          );
          script = script.replace(
            /"darwin"===this.platform/,
            `"darwin"===window.DiscordNative.process.platform`,
          );
          script = script.replace(
            /"linux"===this.platform/,
            `"linux"===window.DiscordNative.process.platform`,
          );
          script = script.replaceAll(
            /(\w)=\w\?\w.remote.require\(".\/Utils"\):null/g,
            `$1=window.DiscordNative?window.DiscordNative.nativeModules.requireModule("discord_utils"):null`,
          );
          script = script.replaceAll(/return (\w)\?(\w).remote\[(\w)\]:(\w)\[(\w)\]/g, ''); // Stubbing
          script = script.replaceAll(
            /this\.require\(".\/VoiceEngine",!0\)/g,
            `window.DiscordNative.nativeModules.requireModule("discord_voice")`,
          );
          script = script.replace(
            /(\w)\.isMaximized\(\)\?\w\.unmaximize\(\):\w\.maximize\(\)/,
            `$1.maximize()`,
          );
          script = script.replace(
            /window.__require\?"Discord Client"/,
            `window.DiscordNative?"Discord Client"`,
          );
          script = script.replaceAll(
            /\w\.remote\.getCurrentWindow\(\)/g,
            `window.DiscordNative.window`,
          );
          script = script.replaceAll(
            /\w\.remote\.require\((\w)\)/g,
            'window.DiscordNative.nativeModules.requireModule($1)',
          );
        }

        // Polyfill botches for specific builds
        if (
          release_date.endsWith('_2016') ||
          (release_date.startsWith('january') && release_date.endsWith('_2017'))
        ) {
          script = script.replace(
            /\w\.setObservedGamesCallback/,
            `window.DiscordNative.nativeModules.requireModule("discord_utils").setObservedGamesCallback`,
          );
          script = script.replaceAll(
            /var (\w+)=\w\["default"\]\.requireElectron\("powerMonitor",!0\);/g,
            `var $1=window.DiscordNative.powerMonitor;`,
          );
          script = script.replace(
            /var \w=\w\["default"\]\._getCurrentWindow\(\)\.webContents;\w\.removeAllListeners\("devtools-opened"\),\w\.on\("devtools-opened",function\(\){return\(0,\w\.consoleWarning\)\(\w\["default"\]\.Messages\)}\)/,
            '',
          );
        }
        if (
          (release_date.endsWith('_2017') && !release_date.startsWith('january')) ||
          (release_date.endsWith('_2018') &&
            (release_date.startsWith('january') ||
              release_date.startsWith('february') ||
              release_date.startsWith('march')))
        ) {
          script = script.replaceAll(
            /this\.getDiscordUtils\(\)/g,
            `window.DiscordNative.nativeModules.requireModule("discord_utils")`,
          );
          script = script.replaceAll(
            /\w\.default\.requireElectron\("powerMonitor",!0\)/g,
            `window.DiscordNative.powerMonitor`,
          );
          script = script.replaceAll(
            /this\.requireElectron\("powerMonitor",!0\)/g,
            `window.DiscordNative.powerMonitor`,
          );
          script = script.replace(
            /var \w=\w\.default\._getCurrentWindow\(\)\.webContents;\w\.removeAllListeners\("devtools-opened"\),\w\.on\("devtools-opened",function\(\){return\(0,\w\.consoleWarning\)\(\w\.default\.Messages\)}\)/,
            '',
          );
        }

        // Desktop Native API fix for 2018+ (Not entirely complete!)
        if (release_date.endsWith('_2018')) {
          script = script.replace(/(\w)\.globals\.releaseChannel/, '$1.app.getReleaseChannel()');
          script = script.replace(/(\w)\.globals\.features/, '$1.features');
          script = script.replace(/(\w)\.globals\[(\w)\]/, '$1[$2]');
          script = script.replace(
            /return \w\.removeAllListeners\("devtools-opened"\),\w\.on\("devtools-opened",function\(\){\w\.emit\("devtools-opened"\)}\),\w/,
            '',
          );
          script = script.replace(
            /var \w=\w\.default\.window\.webContents;\w\.removeAllListeners\("devtools-opened"\),\w\.on\("devtools-opened",function\(\){return\(0,\w\.consoleWarning\)\(\w\.default\.Messages\)}\)/,
            '',
          );
          script = script.replace(
            /return \w\.default\.ensureModule\("discord_spellcheck"\)\.then\(function\(\){var \w=\w.default.requireModule\("discord_spellcheck"\)\.Spellchecker,\w=new \w\(new \w\);return function\(\w\){null!=document\.body&&document\.body\.addEventListener\("input",function\(\w\){null!=\w\.target&&"string"==typeof \w\.target.value&&e.detectLocale\(\w\.target\.value\)},!0\)}\(\w\),\w}\)/,
            '',
          );
        }
      }

      // Electron compatibility (Universal)
      script = script.replaceAll(/"discord:\/\/"/g, `"oldcord://"`);

      // Title replacement
      function sanitize(js) {
        return js.replaceAll(/"/g, '"').replaceAll(/\n|\r/g, '');
      }
      script = script.replaceAll(
        /title:["']Discord["']/g,
        `title:"${sanitize(config.instance.name)}"`,
      );

      // TODO: Fix Discord text change in january-august 2018
      if (
        !release_date.endsWith('2018') ||
        (release_date.endsWith('2018') &&
          !(
            release_date.startsWith('january') ||
            release_date.startsWith('february') ||
            release_date.startsWith('march') ||
            release_date.startsWith('april') ||
            release_date.startsWith('may') ||
            release_date.startsWith('june') ||
            release_date.startsWith('july') ||
            release_date.startsWith('august')
          ))
      ) {
        function replaceDiscord(script) {
          const tokenizerRegex =
            /("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(`(?:\\.|[^`\\])*`)|(\/\/.*)|(\/\*[\s\S]*?\*\/)/g;

          return script.replace(tokenizerRegex, (match) => {
            if (match.startsWith('/') || match.startsWith('*')) {
              return match;
            }

            return match.split(/Discord/).join('Oldcord');
          });
        }

        script = replaceDiscord(script);
      }

      const inviteLink = config.custom_invite_url.replace('https://', '').replace('http://', '');
      const escapedLink = inviteLink.replace(/\./g, '\\.').replace(/\//g, '\\/'); //There was a bug with the developer portal where invites were improperly being replaced into jank regex expressions.

      // Set URLs
      script = script.replaceAll(/d3dsisomax34re.cloudfront.net/g, location.host);
      script = script.replaceAll(/status.discordapp.com/g, location.host);
      script = script.replaceAll(/cdn.discordapp.com/g, location.host);
      script = script.replaceAll(/discordcdn.com/g, location.host); // ??? DISCORDCDN.COM?!!11
      script = script.replaceAll(/discord.gg/g, escapedLink);
      script = script.replaceAll(/discordapp.com/g, location.host);
      script = script.replaceAll(/([a-z]+\.)?discord.media/g, location.host);

      script = script.replaceAll(/e\.exports=n\.p/g, `e.exports="${assets_cdn_url}/assets/"`);

      // Disable HTTPS in insecure mode (for local testing)
      if (location.protocol != 'https')
        script = script.replaceAll('https://', location.protocol + '//');

      // Do NOT interact with sentry. Better to error than send telemetry.
      script = script.replaceAll('sentry.io', '0.0.0.0');
    }

    // Make fields consistent
    if (release_date.endsWith('_2015')) script = script.replaceAll('.presence.', '.presences.');

    // Use unified UserSearch worker script
    window.userSearchWorker = function (url) {
      const wwScript = `importScripts("${assets_cdn_url}/assets/UserSearch.worker.js");`;
      return URL.createObjectURL(new Blob([wwScript], { type: 'text/javascript' }));
    };
    script = script.replace(/n\.p\+"[a-z0-9]+\.worker\.js"/, `window.userSearchWorker()`);

    // Enable april fools @someone experiment
    if (release_date == 'april_1_2018' || release_date == 'april_23_2018')
      script = script.replaceAll('null!=e&&e.bucket!==f.ExperimentBuckets.CONTROL', 'true');

    // Replace text
    function replaceMessage(name, oldValue, value) {
      script = script.replaceAll(new RegExp(`${name}:".*?"`, 'g'), `${name}:"${value}"`);
      if (oldValue) script = script.replaceAll(new RegExp(`"${oldValue}"`, 'gi'), `"${value}"`);
    }
    replaceMessage('FORM_LABEL_SERVER_REGION', 'Server Region', 'Server Era');
    replaceMessage('ONBOARDING_GUILD_SETTINGS_SERVER_REGION', 'Server Region', 'Server Era');
    replaceMessage('REGION_SELECT_HEADER', null, 'Select a server era (build compatibility range)');
    replaceMessage(
      'REGION_SELECT_FOOTER',
      null,
      "The client's build year must match the selected era (e.g., 2015-2016, 2015-2017, 2015-2018) to enable server features. Unsure? Select 'Everything' to allow all client builds to access your server.",
    );

    // Custom flags patch
    if (!release_date.endsWith('_2015')) {
      script = script.replace(
        /("\.\/sydney\.png".*?e\.exports=)\w/,
        '$1(f)=>`${window.assets_cdn_url}/flags/${f.substring(2)}`',
      );
    }

    // Remove useless unknown-field error
    if (kind == 'root')
      script = script.replace("if(!this.has(e))throw new Error('", "if(!this.has(e))return noop('");

    if (release_date.endsWith('_2019')) {
      // Lazily fix 2019. We don't implement user affinities.
      script = script.replaceAll('f.default.getUserAffinitiesUserIds().has(t.id)', 'false');
      script = script.replaceAll(/\w\.userAffinties/g, '[]');
    }

    // Remove VIDEO_PROVIDER_CHECK_UNIX_TIMESTAMP hack
    script = script.replace('1492472454139', '0');

    script = script.replaceAll(
      `OAUTH2_AUTHORIZE:"/api/oauth2/authorize"`,
      `OAUTH2_AUTHORIZE:"/oauth2/authorize"`,
    ); //why does this have /api/ appended but other oauth2 urls dont?
    //Just some last minute housekeeping ^

    // Just for visual verification that it is ptached by Oldcord LMAO

    script = script.replace("returnt", "return t") //bug with voice because of patcher on 2015-2016
    script += '\n// Oldcord Patched';

    return script;
  },
};

export { patcher };
