export interface Config {
    token_secret: string; //The secret used to generate user authorization tokens.
    ack_secret: string; //The secret used to generate message acknowledgement tokens.
    secure: boolean; //Using a locally stored certificate?
    base_url: string; //When this is provided the origin URL is always this, not a mixture of other configuration options.
    gateway_url: string; //Use this to override the gateway URL generation, good for public facing instances which do not want to send out their IP address / port to random people.
    assets_cdn_url : string; //Using your own hosted CDN with oldcord assets? Put it here!
    media_server_public_ip : boolean; //Are you hosting a public facing Oldcord instance? This is then true, or false, if you don't care about voice.
    signaling_server_url: string;
    signaling_server_port: number;
    udp_server_port : number;
    port: number;
    ws_port: number;
    includePortInUrl: boolean;
    includePortInWsUrl: boolean;
    gateway_erlpack: boolean;
    ignore_member_list_subscriptions: boolean;
    serve_selector: boolean;
    intents_required : boolean;
    default_bot_intents : {
        value : number;
    };
    default_user_intents : {
        value : number;
    };
    max_message_embeds: number;
    require_release_date_cookie: boolean;
    cache_authenticated_get_requests: boolean;
    klipy_api_key: string;
    mr_server: {
        enabled: boolean;
        agents: string[];
        config: {
            speaking_throttle_ms: number;
        };
    };
    default_client_build: string;
    debug_logs: {
        gateway : boolean;
        rtc : boolean;
        media : boolean;
        udp : boolean;
        dispatcher : boolean;
        mr : boolean;
        rest : boolean;
        errors: boolean;
        watchdog : boolean;
    };
    instance: {
        name: string;
        description: string;
        environment: string;
        legal: {
            terms: string;
            privacy: string;
            instanceRules: string;
            extras: any; //??
        };
        flags: string[];
    };
    cert_path: string;
    key_path: string;
    captcha_config : {
        type : string;
        secret_key : string;
        site_key : string;
        enabled : boolean;
    };
    email_config : {
        fromAddress : string;
        "brevo-api-key" : string;
        enabled: boolean;
        max_per_timeframe: number;
        timeframe_ms: number;
        ratelimiter_modifier: number;
    };
    limits : {
        username : {
            min : number;
            max : number;
        };
        embeds: {
            max: number;
        };
        password : {
            min : number;
            max : number;
        };
        email : {
            min : number;
            max : number;
        };
        nickname : {
            min : number;
            max : number;
        };
        guild_name : {
            min : number;
            max : number;
        };
        role_name : {
            min : number;
            max : number;
        };
        emoji_name : {
            min : number;
            max : number;
        };
        channel_name : {
            min : number;
            max : number;
        };
        attachments : {
            max_size : number;
        };
        guilds_per_account : {
            max : number;
        };
        invites_per_guild : {
            max : number;
        };
        roles_per_guild : {
            max : number;
        };
        channels_per_guild : {
            max : number;
        };
        emojis_per_guild : {
            max : number;
        };
        messages: {
            min: number;
            max: number;
        }
    };
    trusted_users : string[];
    custom_invite_url : string;
    integration_config : {
        platform: string;
        client_id?: string;
        redirect_uri?: string;
        client_secret?: string;
    }[];
    ratelimit_config : {
        enabled : boolean;
        registration : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        subscriptions: {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        bulkDeleteMessage: {
            maxPerTimeFrame: number;
            timeFrame: number;
            breakdown: number;
        }
        addDmRecipient: {
            maxPerTimeFrame: number;
            timeFrame: number;
            breakdown: number;
        };
        reports : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        bans : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        typing : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        updateChannel : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        deleteChannel : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        tenorSearch : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        createGuild : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        deleteGuild : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        updateGuild : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        messageSearching : {
            maxPerTimeFrame : number;
            timeFrame: number;
            breakdown : number;
        };
        createChannel : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        deleteInvite : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        hypesquadHouseChange: {
            maxPerTimeFrame: number;
            timeFrame: number;
            breakdown: number;
        };
	    useInvite : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        createInvite : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        kickMember : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        banMember : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        updateMember : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        updateNickname : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        sendMessage : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        deleteMessage : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        updateMessage : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        ackMessage : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        addReaction : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        removeReaction : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        updateRole : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        deleteRole : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        createRole : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        createPrivateChannel : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        leaveGuild : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        updateUsersGuildSettings : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        updateMe : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        };
        pins : {
            maxPerTimeFrame : number;
            timeFrame : number;
            breakdown : number;
        }
     };
     serveDesktopClient : boolean;
};