import { RTCOpcode, type RTCHeartbeat, type RTCIdentify } from '../types/rtc.ts';
import { generateSsrc, generateString, miniUserObject } from '../helpers/globalutils.js';
import session from '../helpers/session.js';
import type WebSocket from 'ws';
import { prisma } from '../prisma.ts';
import type { User } from '../types/user.ts';
import type { Account } from '../types/account.ts';
import ctx from '../context.ts';

export const OPCODES = {
  IDENTIFY: 0,
  SELECTPROTOCOL: 1,
  CONNECTIONINFO: 2,
  HEARTBEAT: 3,
  SETUP: 4,
  SPEAKING: 5,
  HEARTBEAT_ACK: 6,
  RESUME: 7,
  HEARTBEAT_INFO: 8,
  INVALID_SESSION: 9,
  SIGNAL: 10,
  VIDEO: 12,
  DISCONNECT: 13,
};

async function handleIdentify(socket: WebSocket, packet: RTCIdentify) {
  const { user_id, server_id, session_id, token } = packet.d;

  if (socket.identified || socket.session) {
    return socket.close(4005, 'You have already identified.');
  }

  socket.identified = true;

  const user = await prisma.user.findUnique({
    where: {
      id: user_id
    },
    select: {
      disabled_until: true,
      username: true,
      discriminator: true,
      settings: true,
      avatar: true,
      bot: true,
      premium: true,
      id: true,
      email: true
    }
  })

  if (!user || user.disabled_until) {
    return socket.close(4004, 'Authentication failed');
  }

  const gatewaySession = ctx.sessions.get(session_id);

  if (!gatewaySession || gatewaySession.user.id !== user.id) {
    return socket.close(4004, 'Authentication failed');
  }

  socket.session = new session(
    `voice:${session_id}`,
    socket,
    user as Account,
    token,
    false,
    {
      game: null,
      status: 'online',
      activities: [],
      user: miniUserObject(user as User),
    },
    'voice',
    gatewaySession.guild_id,
    gatewaySession.channel_id,
    socket.apiVersion,
    socket.client_build_date ?? null,
  );

  socket.gatewaySession = gatewaySession;

  socket.session.guild_id = server_id;
  socket.session.start();

  await socket.session.prepareReady();

  ctx.rtcServer?.debug(`A client's state has changed to -> RTC_CONNECTING`);
  ctx.rtcServer?.debug(`Client ${socket.user_id} has identified.`);

  const roomId = `${socket.gatewaySession?.guild_id}-${socket.gatewaySession?.channel_id}`;

  socket.roomId = roomId;

  ctx.rtcServer?.clients.set(socket.user_id!, socket);

  if (!ctx.using_media_relay) {
    socket.client = await ctx.mediaserver?.join(roomId, user.id, socket, 'guild-voice');

    socket.on('close', () => {
      ctx.mediaserver?.onClientClose(socket.client);
    });

    socket.client.initIncomingSSRCs({
      audio_ssrc: 0,
      video_ssrc: 0,
      rtx_ssrc: 0,
    });

    socket.send(
      JSON.stringify({
        op: RTCOpcode.READY,
        d: {
          ssrc: generateSsrc(),
          ip: ctx.mediaserver?.ip,
          port: ctx.mediaserver?.port,
          modes: ['plain', 'xsalsa20_poly1305'],
          heartbeat_interval: 1,
        },
      }),
    );
  } else {
    let lat = 0;
    let lon = 0;

    try {
      const userIp = socket.ip_address;
      if (userIp && userIp !== '127.0.0.1' && userIp !== '::1') {
        const response = await fetch(`http://ip-api.com/json/${userIp}`);
        if (response.ok) {
          const data = (await response.json()) as any;
          if (data.status === 'success') {
            lat = data.lat;
            lon = data.lon;
          }
        }
      }
    } catch (e) {
      // Ignore
    }

    const mediaServer = ctx.mrServer?.getClosestMediaServer(lat, lon);

    if (mediaServer === null) {
      return;
    }

    socket.on('close', () => {
      mediaServer?.socket.send(
        JSON.stringify({
          op: 'CLIENT_CLOSE',
          d: {
            ip_address: socket.ip_address,
            user_id: socket.user_id,
          },
        }),
      );
    });

    const identity_ssrc = generateSsrc();

    mediaServer?.socket.send(
      JSON.stringify({
        op: 'CLIENT_IDENTIFY',
        d: {
          ip_address: socket.ip_address,
          user_id: socket.user_id,
          ssrc: identity_ssrc,
          room_id: roomId,
        },
      }),
    );

    socket.mediaServer = mediaServer;

    socket.send(
      JSON.stringify({
        op: RTCOpcode.READY,
        d: {
          ssrc: identity_ssrc,
          ip: mediaServer?.ip,
          port: mediaServer?.port,
          modes: ['plain', 'xsalsa20_poly1305'],
          heartbeat_interval: 1,
        },
      }),
    );
  }
}

async function handleHeartbeat(socket: WebSocket, packet: RTCHeartbeat) {
  if (!socket.hb) return;

  socket.hb.acknowledge(packet.d);
  socket.hb.reset();
}

async function handleSelectProtocol(socket: WebSocket, packet: any) {
  const protocol = packet.d.protocol;

  ctx.rtcServer?.protocolsMap.set(socket.user_id, protocol ?? 'webrtc');

  const keyBuffer = ctx.rtcServer?.randomKeyBuffer();

  ctx.udpServer?.encryptionsMap.set(socket.ssrc, {
    mode: 'xsalsa20_poly1305',
    key: Array.from(keyBuffer as Uint8Array<ArrayBufferLike>),
  });

  if (protocol === 'webrtc') {
    const sdp = packet.d.sdp || packet.d.data;
    const codecs = packet.d.codecs || [
      {
        name: 'opus',
        type: 'audio',
        priority: 1000,
        payload_type: 111,
      },
    ];

    const client_build = socket.client_build;
    const client_build_date = socket.client_build_date; //to-do add to underlying socket object

    if (!ctx.using_media_relay) {
      const answer = await ctx.mediaserver?.onOffer(
        client_build!,
        client_build_date!,
        socket.client,
        sdp,
        codecs,
      );

      return socket.send(
        JSON.stringify({
          op: RTCOpcode.SESSION_DESCRIPTION,
          d: {
            sdp: answer?.sdp,
            audio_codec: 'opus',
            video_codec: answer?.selectedVideoCodec,
          },
        }),
      );
    }

    const mediaServer = socket.mediaServer;

    if (!mediaServer) {
      return;
    }

    mediaServer.socket.send(
      JSON.stringify({
        op: 'OFFER',
        d: {
          sdp: sdp,
          codecs: codecs,
          ip_address: socket.ip_address,
          user_id: socket.user_id,
          room_id: socket.roomId,
          client_build: client_build,
          client_build_date: client_build_date,
        },
      }),
    );

    mediaServer.socket.emitter.on('answer-received', (answer: {
      sdp: string,
      audio_codec: string,
      video_codec: string
    }) => {
      socket.send(
        JSON.stringify({
          op: RTCOpcode.SESSION_DESCRIPTION,
          d: {
            sdp: answer.sdp,
            audio_codec: answer.audio_codec,
            video_codec: answer.video_codec,
          },
        }),
      );
    });
  } else if (protocol === 'webrtc-p2p') {
    return socket.send(
      JSON.stringify({
        op: RTCOpcode.SESSION_DESCRIPTION,
        d: {
          peers: Array.from(ctx.rtcServer!.clients!.keys()).filter((id) => socket.user_id != id),
        },
      }),
    );
  } else {
    return socket.send(
      JSON.stringify({
        op: RTCOpcode.SESSION_DESCRIPTION,
        d: {
          mode: 'xsalsa20_poly1305',
          secret_key: Array.from(keyBuffer as Uint8Array<ArrayBufferLike>),
        },
      }),
    );
  }
}

async function handleICECandidates(socket: WebSocket, packet: any) {
  if (!ctx.rtcServer!.protocolsMap.has(socket.user_id) || ctx.rtcServer!.protocolsMap.has(packet.d.user_id)) {
    return;
  }

  const protocol = ctx.rtcServer?.protocolsMap.get(socket.user_id);
  const theirProtocol = ctx.rtcServer?.protocolsMap.get(packet.d.user_id);

  if (protocol !== 'webrtc-p2p' || theirProtocol !== 'webrtc-p2p') {
    ctx.rtcServer?.debug(
      `A client tried to send ICE candidates to another client, when one (or both) of them aren't using the webrtc-p2p protocol.`,
    );
    return;
  }

  const recipientId = packet.d.user_id;
  const recipientSocket = ctx.rtcServer?.clients.get(recipientId);

  if (recipientSocket) {
    const forwardedPayload = { ...packet.d, user_id: socket.user_id };
    const forwardedMessage = { op: RTCOpcode.ICE_CANDIDATES, d: forwardedPayload };

    recipientSocket.send(JSON.stringify(forwardedMessage));

    ctx.rtcServer?.debug(`Forwarded ICE candidates from ${socket.user_id} to ${recipientId}`);
  } else {
    ctx.rtcServer?.debug(
      `Couldn't forward ICE candidates to recipient ${recipientId}, their corresponding websocket was not found.`,
    );
  }
}

async function handleSpeaking(socket: WebSocket, packet: any) {
  const ssrc = packet.d.ssrc;
  const protocol = ctx.rtcServer?.protocolsMap.get(socket.user_id);

  if (protocol === 'webrtc') {
    if (!ctx.using_media_relay) {
      if (!socket.client.voiceRoomId) {
        return;
      }

      if (!socket.client.isProducingAudio()) {
        ctx.rtcServer?.debug(
          `Client ${socket.user_id} sent a speaking packet but has no audio producer.`,
        );
        return;
      }

      const incomingSSRCs = socket.client.getIncomingStreamSSRCs();

      if (incomingSSRCs.audio_ssrc !== ssrc) {
        console.log(
          `[${socket.user_id}] SSRC mismatch detected. Correcting audio SSRC from ${incomingSSRCs.audio_ssrc} to ${ssrc}.`,
        );

        socket.client.stopPublishingTrack('audio');

        socket.client.initIncomingSSRCs({
          audio_ssrc: ssrc,
          video_ssrc: incomingSSRCs.video_ssrc,
          rtx_ssrc: incomingSSRCs.rtx_ssrc,
        });

        await socket.client.publishTrack('audio', { audio_ssrc: ssrc });

        const clientsToNotify = new Set();

        for (const otherClient of socket.client.room.clients.values()) {
          if (otherClient.user_id === socket.user_id) continue;

          await otherClient.subscribeToTrack(socket.client.user_id, 'audio');

          clientsToNotify.add(otherClient);
        }

        await Promise.all(
          Array.from(clientsToNotify).map((client: any) => {
            const updatedSsrcs = client.getOutgoingStreamSSRCsForUser(socket.user_id);

            client.websocket.send(
              JSON.stringify({
                op: RTCOpcode.VIDEO,
                d: {
                  user_id: socket.user_id,
                  audio_ssrc: updatedSsrcs.audio_ssrc,
                  video_ssrc: updatedSsrcs.video_ssrc,
                  rtx_ssrc: updatedSsrcs.rtx_ssrc,
                },
              }),
            );
          }),
        );
      }

      await Promise.all(
        Array.from(ctx.mediaserver!.getClientsForRtcServer(socket.client.voiceRoomId)).map(
          (client: any) => {
            if (client.user_id === socket.user_id) return Promise.resolve();

            const ssrcInfo = client.getOutgoingStreamSSRCsForUser(socket.user_id);

            if (packet.d.speaking && ssrcInfo.audio_ssrc === 0) {
              ctx.rtcServer?.debug(
                `Suppressing speaking packet for ${client.user_id} as consumer for ${socket.user_id} is not ready (ssrc=0).`,
              );
              return Promise.resolve();
            }

            return client.websocket.send(
              JSON.stringify({
                op: RTCOpcode.SPEAKING,
                d: {
                  user_id: socket.user_id,
                  speaking: packet.d.speaking,
                  ssrc: ssrcInfo.audio_ssrc,
                },
              }),
            );
          },
        ),
      );
    } else {
      const mediaServer = socket.mediaServer;

      if (!mediaServer) {
        return;
      }

      mediaServer.socket.send(
        JSON.stringify({
          op: 'CLIENT_SPEAKING',
          d: {
            ip_address: socket.ip_address,
            user_id: socket.user_id,
            room_id: socket.roomId,
            speaking: packet.d.speaking,
            audio_ssrc: ssrc,
          },
        }),
      );

      mediaServer.socket.emitter.on('speaking-batch', (speaking_batch: any) => {
        console.log(`Received speaking-batch for ${Object.keys(speaking_batch).length} clients.`);

        for (const [recipientId, speakingPacket] of Object.entries(speaking_batch)) {
          const clientSocket = ctx.rtcServer?.clients.get(recipientId);

          if (clientSocket && clientSocket.roomId === socket.roomId) {
            clientSocket.send(JSON.stringify(speakingPacket));
          }
        }
      });
    }
  } else {
    for (const [id, clientSocket] of ctx.rtcServer!.clients) {
      if (id !== socket.user_id) {
        clientSocket.send(
          JSON.stringify({
            op: RTCOpcode.SPEAKING,
            d: {
              speaking: packet.d.speaking,
              ssrc: ssrc,
              user_id: socket.user_id,
            },
          }),
        );
      }
    }
  }
}

async function handleVideo(socket: WebSocket, packet: any) {
  const { video_ssrc, rtx_ssrc, audio_ssrc } = packet.d;
  const response = {
    audio_ssrc: audio_ssrc,
    video_ssrc: video_ssrc,
    rtx_ssrc: rtx_ssrc,
    user_id: ""
  };

  const protocol = ctx.rtcServer?.protocolsMap.get(socket.user_id);

  if (protocol === 'webrtc') {
    if (!ctx.using_media_relay) {
      const clientsThatNeedUpdate = new Set();
      const wantsToProduceAudio = audio_ssrc !== 0;
      const wantsToProduceVideo = video_ssrc !== 0;

      const isCurrentlyProducingAudio = socket.client.isProducingAudio();
      const isCurrentlyProducingVideo = socket.client.isProducingVideo();

      socket.client.initIncomingSSRCs({
        audio_ssrc: audio_ssrc,
        video_ssrc: video_ssrc,
        rtx_ssrc: rtx_ssrc,
      });

      if (wantsToProduceAudio && !isCurrentlyProducingAudio) {
        console.log(`[${socket.user_id}] Starting audio production with ssrc ${audio_ssrc}`);
        await socket.client.publishTrack('audio', { audio_ssrc: audio_ssrc });

        for (const client of socket.client.room.clients.values()) {
          if (client.user_id === socket.user_id) continue;
          await client.subscribeToTrack(socket.client.user_id, 'audio');
          clientsThatNeedUpdate.add(client);
        }
      } else if (!wantsToProduceAudio && isCurrentlyProducingAudio) {
        console.log(`[${socket.user_id}] Stopping audio production.`);
        socket.client.stopPublishingTrack('audio');

        for (const client of socket.client.room.clients.values()) {
          if (client.user_id !== socket.user_id) clientsThatNeedUpdate.add(client);
        }
      }

      if (wantsToProduceVideo && !isCurrentlyProducingVideo) {
        console.log(`[${socket.user_id}] Starting video production with ssrc ${video_ssrc}`);
        await socket.client.publishTrack('video', {
          video_ssrc: video_ssrc,
          rtx_ssrc: rtx_ssrc,
        });
        for (const client of socket.client.room.clients.values()) {
          if (client.user_id === socket.user_id) continue;
          await client.subscribeToTrack(socket.client.user_id, 'video');
          clientsThatNeedUpdate.add(client);
        }
      } else if (!wantsToProduceVideo && isCurrentlyProducingVideo) {
        console.log(`[${socket.user_id}] Stopping video production.`);
        socket.client.stopPublishingTrack('video');
        for (const client of socket.client.room.clients.values()) {
          if (client.user_id !== socket.user_id) clientsThatNeedUpdate.add(client);
        }
      }

      await Promise.all(
        Array.from(clientsThatNeedUpdate).map((client: any) => {
          const ssrcs = client.getOutgoingStreamSSRCsForUser(socket.user_id);
          client.websocket.send(
            JSON.stringify({
              op: RTCOpcode.VIDEO,
              d: {
                user_id: socket.user_id,
                audio_ssrc: ssrcs.audio_ssrc,
                video_ssrc: ssrcs.video_ssrc,
                rtx_ssrc: ssrcs.rtx_ssrc,
              },
            }),
          );
        }),
      );
    } else {
      const mediaServer = socket.mediaServer;

      if (!mediaServer) {
        return;
      }

      mediaServer.socket.send(
        JSON.stringify({
          op: 'VIDEO',
          d: {
            user_id: socket.user_id,
            room_id: socket.roomId,
            ip_address: socket.ip_address,
            audio_ssrc: audio_ssrc,
            video_ssrc: video_ssrc,
            rtx_ssrc: rtx_ssrc,
          },
        }),
      );

      mediaServer.socket.emitter.on('video-batch', (video_batch: any) => {
        for (const [recipientId, videoPacket] of Object.entries(video_batch)) {
          const clientSocket = ctx.rtcServer!.clients.get(recipientId);

          if (clientSocket && clientSocket.roomId === socket.roomId) {
            clientSocket.send(JSON.stringify(videoPacket));
          }
        }
      });
    }
  } else {
    for (const [id, clientSocket] of ctx.rtcServer!.clients) {
      if (id !== socket.user_id) {
        response.user_id = socket.user_id!;

        clientSocket.send(
          JSON.stringify({
            op: RTCOpcode.VIDEO,
            d: response,
          }),
        );
      }
    }
  }
}

async function handleResume(socket: WebSocket, packet: any) {
  const { token, session_id, server_id } = packet.d;
  
  if (!token || !session_id) {
    return socket.close(4000, 'Invalid payload');
  }

  if (socket.session || socket.resumed) {
    return socket.close(4005, 'Cannot resume at this time');
  }

  socket.resumed = true;

  const user = await prisma.user.findUnique({
    where: {
      id: socket.user_id
    },
    select: {
      disabled_until: true,
      username: true,
      discriminator: true,
      settings: true,
      avatar: true,
      bot: true,
      premium: true,
      id: true,
      token: true,
      email: true
    }
  })

  if (!user || user.disabled_until || user.token !== token) {
    return socket.close(4004, 'Authentication failed');
  }

  const session2 = ctx.sessions.get(`voice:${session_id}`);

  if (!session2) {
     socket.session = new session(
      generateString(16),
      socket,
      user as Account,
      token,
      false,
      {
        game: null,
        status: 'online',
        activities: [],
        user: user as Partial<User> & { id: string },
      },
      'voice',
      server_id,
      "0",
      socket.apiVersion,
      packet.d.capabilities ?? socket.client_build_date,
    );

    socket.session.start();
  }

  const sesh = session2 ?? socket.session;

  if (sesh) {
    sesh.user = session2!.user;
  }

  sesh.guild_id = server_id;

  socket.send(
    JSON.stringify({
      op: RTCOpcode.INVALID_SESSION,
      d: null,
    }),
  );
}

type RtcHandler = (socket: WebSocket, packet: any) => Promise<void> | void;

const rtcHandlers: Record<number, RtcHandler> = {
  [RTCOpcode.IDENTIFY]: handleIdentify,
  [RTCOpcode.SELECT_PROTOCOL]: handleSelectProtocol,
  [RTCOpcode.HEARTBEAT]: handleHeartbeat,
  [RTCOpcode.SPEAKING]: handleSpeaking,
  [RTCOpcode.RESUME]: handleResume,
  [RTCOpcode.ICE_CANDIDATES]: handleICECandidates,
  [RTCOpcode.VIDEO]: handleVideo,
};

export { rtcHandlers };
