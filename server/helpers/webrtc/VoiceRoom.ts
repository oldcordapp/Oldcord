import ctx from "../../context.ts";
import type { MediasoupWebRtcClient } from "./MediasoupWebRtcClient.ts";

class VoiceRoom {
  private _id: string;
  public _type: string;
  public _clients: Map<string,  MediasoupWebRtcClient>;
  public _router: any;
  
  //_sfu is deprecated
  constructor(id: string, type: string, _sfu: any, router: any) {
    this._id = id;
    this._type = type;
    this._clients = new Map();
    this._router = router;
  }

  onClientJoin = (client: any) => {
    this._clients.set(client.user_id, client);
  };

  onClientOffer = (client: any, transport: any, codecs: any[], rtpHeaders: any) => {
    client.transport = transport;
    client.codecs = codecs;
    client.headerExtensions = rtpHeaders;

    const supportedCodecs = ctx.MEDIA_CODECS.map((codec: any) => {
      const codecName = codec.mimeType.split('/')[1];
      const alternativePayloadType = codecName === 'opus' ? 111 : 102;
      return {
        ...codec,
        preferredPayloadType:
          codecs.find((c) => c.name.toUpperCase() === codecName.toUpperCase())?.payload_type ??
          alternativePayloadType,
      };
    });

    client.codecCapabilities = supportedCodecs;
  };

  onClientLeave = (client: any) => {
    this._clients.delete(client.user_id);

    for (const otherClient of this.clients.values()) {
      if (otherClient.user_id === client.user_id) continue;

      otherClient.consumers?.forEach((consumer) => {
        if (
          client?.audioProducer?.id === consumer.producerId ||
          client?.videoProducer?.id === consumer.producerId
        ) {
          consumer.close();
        }
      });
    }

    client.consumers?.forEach((consumer: any) => consumer.close());
    client.audioProducer?.close();
    client.videoProducer?.close();
    client.transport?.close();
    client.isStopped = true;
    client.room = undefined;
    client.audioProducer = undefined;
    client.videoProducer = undefined;
    client.consumers = [];
    client.transport = undefined;
    client.websocket = undefined;
    client.emitter.removeAllListeners();
  };

  get clients() {
    return this._clients;
  }

  getClientById = (id: string) => {
    return this._clients.get(id);
  };

  get id() {
    return this._id;
  }

  get type() {
    return this._type;
  }

  get router() {
    return this._router;
  }
}

export { VoiceRoom };
