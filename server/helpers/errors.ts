// This list is taken from https://docs.discord.food/datamining/errors with some removed because of 2019+ features
// Thanks discord.food!
// There are also custom Oldcord-specific errors here too.

const errors = {
  response_400: {
    MAX_GUILDS: {
      code: 30001,
      message: 'Maximum number of guilds reached',
    },
    MAX_FRIENDS: {
      code: 30002,
      message: 'Maximum number of friends reached',
    },
    MAX_PINS: {
      code: 30003,
      message: 'Maximum number of pins reached for the channel',
    },
    MAX_RECIPIENTS: {
      code: 30004,
      message: 'Maximum number of recipients reached',
    },
    MAX_GUILD_ROLES: {
      code: 30005,
      message: 'Maximum number of guild roles reached',
    },
    TOO_MANY_USERS: {
      code: 30006,
      message: 'Too many users have this username, please try another',
    },
    MAX_WEBHOOKS: {
      code: 30007,
      message: 'Maximum number of webhooks reached',
    },
    MAX_EMOJIS: {
      code: 30008,
      message: 'Maximum number of emojis reached',
    },
    MAX_CONNECTIONS: {
      code: 30009,
      message: 'Maximum number of connections reached',
    },
    MAX_REACTIONS: {
      code: 30010,
      message: 'Maximum number of reactions reached',
    },
    MAX_GROUP_DMS: {
      code: 30011,
      message: 'Maximum number of group DMs reached',
    },
    MAX_GUILD_CHANNELS: {
      code: 30013,
      message: 'Maximum number of guild channels reached',
    },
    MAX_ATTACHMENTS: {
      code: 30015,
      message: 'Maximum number of attachments in a message reached',
    },
    MAX_INVITES: {
      code: 30016,
      message: 'Maximum number of invites to this server reached.',
    },
    MAX_ANIMATED_EMOJIS: {
      code: 30018,
      message: 'Maximum number of animated emojis reached',
    },
    MAX_SERVER_MEMBERS: {
      code: 30019,
      message: 'Maximum number of server members reached',
    },
    MAX_SERVER_CATEGORIES: {
      code: 30030,
      message: 'Maximum number of server categories has been reached',
    },
    MAX_BANS_FETCHES: {
      code: 30037,
      message: 'Max number of bans fetches has been reached. Try again later',
    },
    MAX_PRUNE_REQUESTS: {
      code: 30040,
      message: 'Maximum number of prune requests has been reached. Try again later',
    },
    MAX_Guild_WIDGET_UPDATES: {
      code: 30042,
      message: 'Maximum number of guild widget settings updates has been reached. Try again later',
    },
    MAX_MESSAGE_EDITS_OLDER_THAN_HOUR: {
      code: 30046,
      message: 'Maximum number of edits to messages older than 1 hour reached. Try again later',
    },
    BITRATE_TOO_HIGH: {
      code: 30052,
      message: 'Bitrate is too high for channel of this type',
    },
    MAX_WEBHOOKS_PER_GUILD: {
      code: 30058,
      message: 'Maximum number of webhooks per guild reached',
    },
    MAX_CHANNEL_OVERWRITES: {
      code: 30060,
      message: 'Maximum number of channel permission overwrites reached',
    },
    GUILD_CHANNELS_TOO_LARGE: {
      code: 30061,
      message: 'The channels for this guild are too large',
    },
    REQUEST_ENTITY_TOO_LARGE: {
      code: 40005,
      message: 'Request entity too large',
    },
    OLDCORD_TAG_TAKEN: {
      code: 40008,
      message: 'That OldcordTag is already taken', // Originally That DiscordTag is already taken but we're Oldcord not Discord
    },
    OWNERSHIP_TRANSFER_REQUIRED: {
      code: 40011,
      message: 'You must transfer ownership of any owned guilds before deleting your account',
    },
    SERVICE_UNAVAILABLE: {
      code: 40016,
      message: 'Service is currently unavailable.',
    },
    TAG_NAMES_MUST_BE_UNIQUE: {
      code: 40061,
      message: 'Tag names must be unique',
    },
    INVALID_ACCOUNT_TYPE: {
      code: 50002,
      message: 'Invalid account type',
    },
    WIDGET_DISABLED: {
      code: 50004,
      message: 'Widget Disabled',
    },
    CANNOT_EDIT_OTHER_USER_MESSAGE: {
      code: 50005,
      message: 'Cannot edit a message authored by another user',
    },
    CANNOT_SEND_EMPTY_MESSAGE: {
      code: 50006,
      message: 'Cannot send an empty message',
    },
    CANNOT_SEND_MESSAGES_IN_NON_TEXT_CHANNEL: {
      code: 50008,
      message: 'Cannot send messages in a non-text channel',
    },
    CHANNEL_VERIFICATION_LEVEL_TOO_HIGH: {
      code: 50009,
      message: 'Channel verification level is too high for you to gain access',
    },
    OAUTH2_APPLICATION_BOT_ABSENT: {
      code: 50010,
      message: 'OAuth2 application does not have a bot',
    },
    MAX_OAUTH2_APPLICATIONS: {
      code: 50011,
      message: 'OAuth2 application limit reached',
    },
    INVALID_OAUTH_STATE: {
      code: 50012,
      message: 'Invalid OAuth State',
    },
    INVALID_AUTHENTICATION_TOKEN: {
      code: 50014,
      message: 'Invalid authentication token',
    },
    NOTE_TOO_LONG: {
      code: 50015,
      message: 'Note was too long',
    },
    INVALID_BULK_DELETE_COUNT: {
      code: 50016,
      message:
        'Provided too few or too many messages to delete. Must provide at least 2 and fewer than 100 messages to delete.',
    },
    INVALID_MFA_LEVEL: {
      code: 50017,
      message: 'Invalid MFA Level',
    },
    INVALID_PASSWORD: {
      code: 50018,
      message: 'Password does not match',
    },
    INVALID_PIN_CHANNEL: {
      code: 50019,
      message: 'A message can only be pinned to the channel it was sent in',
    },
    INVALID_INVITE_CODE: {
      code: 50020,
      message: 'Invite code was either invalid or taken',
    },
    INVALID_SYSTEM_MESSAGE_ACTION: {
      code: 50021,
      message: 'Cannot execute action on a system message',
    },
    INVALID_CLIENT_ID: {
      code: 50023,
      message: 'Invalid client id',
    },
    INVALID_CHANNEL_TYPE_ACTION: {
      code: 50024,
      message: 'Cannot execute action on this channel type',
    },
    INVALID_OAUTH2_ACCESS_TOKEN: {
      code: 50025,
      message: 'Invalid OAuth2 access token',
    },
    MISSING_OAUTH2_SCOPE: {
      code: 50026,
      message: 'Missing required OAuth2 scope',
    },
    INVALID_WEBHOOK_TOKEN: {
      code: 50027,
      message: 'Invalid webhook token provided',
    },
    INVALID_ROLE: {
      code: 50028,
      message: 'Invalid role',
    },
    INVALID_RECIPIENTS: {
      code: 50033,
      message: 'Invalid Recipient(s)',
    },
    BULK_DELETE_MESSAGE_TOO_OLD: {
      code: 50034,
      message: 'A message provided was too old to bulk delete',
    },
    INVALID_FORM_BODY: {
      code: 50035,
      message: 'Invalid Form Body',
    },
    INVITE_ACCEPTED_TO_GUILD_WITHOUT_BOT: {
      code: 50036,
      message: "You cannot accept an invite to a server that the application's bot is not in.",
    },
    INVALID_ACTIVITY_ACTION: {
      code: 50039,
      message: 'Invalid Activity Action',
    },
    FILE_EXCEEDS_MAXIMUM_SIZE: {
      code: 50045,
      message: 'File uploaded exceeds the maximum size',
    },
    INVALID_FILE_UPLOADED: {
      code: 50046,
      message: 'Invalid Asset',
    },
    GIFT_REDEEMED_ALREADY: {
      code: 50050,
      message: 'This gift has been redeemed already.'
    },
    INVALID_GUILD: {
      code: 50055,
      message: 'Invalid Guild',
    },
    INVALID_MESSAGE_TYPE: {
      code: 50068,
      message: 'Invalid message type',
    },
    CANNOT_MODIFY_SYSTEM_WEBHOOK: {
      code: 50073,
      message: 'Cannot modify a system webhook',
    },
    INSUFFICIENT_BOOSTS: {
      code: 50101,
      message: 'This server needs more boosts to perform this action',
    },
    INVALID_JSON: {
      code: 50109,
      message: 'The request body contains invalid JSON.',
    },
    OWNERSHIP_CANNOT_BE_TRANSFERRED_TO_BOT: {
      code: 50132,
      message: 'Ownership cannot be transferred to a bot user',
    },
    UPLOADED_FILE_NOT_FOUND: {
      code: 50146,
      message: 'Uploaded file not found',
    },
    INVALID_NICKNAME_LENGTH: {
      code: 50500,
      message: 'Invalid nickname length',
    },
    TWOFA_ALREADY_ENABLED: {
      code: 60001,
      message: 'This account is already enrolled in two factor authentication',
    },
    TWOFA_NOT_ENABLED: {
      code: 60002,
      message: 'This account is not enrolled in two factor authentication',
    },
    TWOFA_REQUIRED: {
      code: 60003,
      message: 'Two factor is required for this operation',
    },
    INVALID_TWOFA_SECRET: {
      code: 60005,
      message: 'Invalid two-factor secret',
    },
    INVALID_TWOFA_TICKET: {
      code: 60006,
      message: 'Invalid two-factor auth ticket',
    },
    INVALID_TWOFA_CODE: {
      code: 60008,
      message: 'Invalid two-factor code / Security key authentication failed',
    },
    INVALID_TWOFA_SESSION: {
      code: 60009,
      message: 'Invalid two-factor session',
    },
    ADMIN_USE_BOT_TAB: {
      code: 9000001,
      message: 'Please use the "Bots" tab to lookup bots.',
    },
    INVALID_ACTION_STATE: {
      code: 9000002,
      message: 'Invalid action state',
    },
    INVALID_PRIVILEGE: {
      code: 9000003,
      message: 'Invalid Privilege',
    },
    PARAM_MISSING: {
      code: 9000004,
      message: 'Parameters are missing.',
    },
  },
  response_401: {
    UNAUTHORIZED: {
      code: 40001,
      message: 'Unauthorized',
    },
    INVALID_AUTH_TOKEN: {
      code: 50014,
      message: 'Invalid authentication token',
    },
  },
  response_403: {
    BOTS_CANNOT_USE_THIS_ENDPOINT: {
      code: 20001,
      message: 'Bots cannot use this endpoint',
    },
    ONLY_BOTS_CAN_USE_THIS_ENDPOINT: {
      code: 20002,
      message: 'Only bots can use this endpoint',
    },
    RPC_PROXY_DISALLOWED: {
      code: 20003,
      message: 'RPC proxy disallowed',
    },
    EXPLICIT_CONTENT_CANNOT_BE_SENT: {
      code: 20009,
      message: 'Explicit content cannot be sent to the desired recipient(s)',
    },
    NOT_AUTHORIZED_FOR_APPLICATION: {
      code: 20012,
      message: 'You are not authorized to perform this action on this application',
    },
    ACCOUNT_DISABLED: {
      code: 20013,
      message: 'This account is disabled',
    },
    ONLY_OWNER_CAN_PERFORM: {
      code: 20018,
      message: 'Only the owner of this account can perform this action',
    },
    ANNOUNCEMENT_RATE_LIMITS: {
      code: 20022,
      message: 'This message cannot be edited due to announcement rate limits',
    },
    WRITE_RATE_LIMIT_CHANNEL: {
      code: 20028,
      message: 'The write action you are performing on the channel has hit the write rate limit.',
    },
    WRITE_RATE_LIMIT_SERVER: {
      code: 20029,
      message: 'The write action you are performing on the server has hit the write rate limit',
    },
    MUST_BE_FRIENDS: {
      code: 20037,
      message: 'You must be friends with this user to perform this action',
    },
    BOT_DISABLED: {
      code: 20500,
      message: 'This bot is disabled',
    },
    ACCOUNT_VERIFICATION_REQUIRED: {
      code: 40002,
      message: 'You need to verify your account in order to perform this action',
    },
    OPENING_DMS_TOO_FAST: {
      code: 40003,
      message: 'You are opening direct messages too fast',
    },
    SEND_MESSAGE_DISABLED: {
      code: 40004,
      message: 'Send message has been temporarily disabled.',
    },
    FEATURE_TEMPORARILY_DISABLED: {
      code: 40006,
      message: 'This feature has been temporarily disabled',
    },
    USER_BANNED_FROM_GUILD: {
      code: 40007,
      message: 'The user is banned from this guild',
    },
    MUST_CLAIM_ACCOUNT: {
      code: 40013,
      message: 'This account must be claimed.',
    },
    USER_NOT_IN_VOICE: {
      code: 40032,
      message: 'Target user is not connected to voice.',
    },
    MISSING_ACCESS: {
      code: 50001,
      message: 'Missing Access',
    },
    CANNOT_SEND_MESSAGES_TO_THIS_USER: {
      code: 50007,
      message: 'Cannot send messages to this user',
    },
    MISSING_PERMISSIONS: {
      code: 50013,
      message: 'Missing Permissions',
    },
    CANNOT_EXECUTE_ON_SYSTEM_MESSAGE: {
      code: 50021,
      message: 'Cannot execute action on a system message',
    },
    YOU_CANNOT_PERFORM_ACTION_ON_YOURSELF: {
      code: 50038,
      message: 'You cannot perform this action on yourself',
    },
    MFA_REQUIRED: {
      code: 60003,
      message: 'Two factor is required for this operation',
    },
    INCOMING_FRIEND_REQUESTS_DISABLED: {
      code: 80000,
      message: 'Incoming friend requests disabled',
    },
    FRIEND_REQUEST_BLOCKED: {
      code: 80001,
      message: 'Friend request blocked',
    },
    BOTS_CANNOT_HAVE_FRIENDS: {
      code: 80002,
      message: 'Bots cannot have friends',
    },
    CANNOT_FRIEND_SELF: {
      code: 80003,
      message: 'Cannot send friend request to self',
    },
    USER_DOES_NOT_EXIST: {
      code: 80004,
      message: 'No users with OldcordTag exist',
    },
    NO_INCOMING_FRIEND_REQUEST: {
      code: 80005,
      message: 'You do not have an incoming friend request from that user',
    },
    MUST_BE_FRIENDS_TO_CHANGE: {
      code: 80006,
      message: 'You need to be friends in order to make this change.',
    },
    ALREADY_FRIENDS: {
      code: 80007,
      message: 'You are already friends with that user.',
    },
    MUST_INCLUDE_DISCRIMINATOR: {
      code: 80008,
      message: 'You must include a discriminator.',
    },
    REACTION_BLOCKED: {
      code: 90001,
      message: 'Reaction was blocked',
    },
    MESSAGE_BLOCKED_BY_FILTER: {
      code: 240000,
      message: 'Message blocked by harmful links filter',
    },
  },
  response_404: {
    NOT_FOUND: {
      code: 0,
      message: '404: Not Found',
    },
    UNKNOWN_ACCOUNT: {
      code: 10001,
      message: 'Unknown Account',
    },
    UNKNOWN_APPLICATION: {
      code: 10002,
      message: 'Unknown Application',
    },
    UNKNOWN_CHANNEL: {
      code: 10003,
      message: 'Unknown Channel',
    },
    UNKNOWN_GUILD: {
      code: 10004,
      message: 'Unknown Guild',
    },
    UNKNOWN_INTEGRATION: {
      code: 10005,
      message: 'Unknown Integration',
    },
    UNKNOWN_INVITE: {
      code: 10006,
      message: 'Unknown Invite',
    },
    UNKNOWN_MEMBER: {
      code: 10007,
      message: 'Unknown Member',
    },
    UNKNOWN_MESSAGE: {
      code: 10008,
      message: 'Unknown Message',
    },
    UNKNOWN_OVERWRITE: {
      code: 10009,
      message: 'Unknown Permission Overwrite',
    },
    UNKNOWN_PROVIDER: {
      code: 10010,
      message: 'Unknown Provider',
    },
    UNKNOWN_ROLE: {
      code: 10011,
      message: 'Unknown Role',
    },
    UNKNOWN_TOKEN: {
      code: 10012,
      message: 'Unknown Token',
    },
    UNKNOWN_USER: {
      code: 10013,
      message: 'Unknown User',
    },
    UNKNOWN_EMOJI: {
      code: 10014,
      message: 'Unknown Emoji',
    },
    UNKNOWN_WEBHOOK: {
      code: 10015,
      message: 'Unknown Webhook',
    },
    UNKNOWN_CONNECTION: {
      code: 10017,
      message: 'Unknown Connection',
    },
    UNKNOWN_BAN: {
      code: 10026,
      message: 'Unknown Ban',
    },
    UNKNOWN_SKU: {
      code: 10027,
      message: 'Unknown SKU',
    },
    UNKNOWN_STORE_LISTING: {
      code: 10028,
      message: 'Unknown Store Listing',
    },
    UNKNOWN_ENTITLEMENT: {
      code: 10029,
      message: 'Unknown Entitlement',
    },
    UNKNOWN_BUILD: {
      code: 10030,
      message: 'Unknown Build',
    },
    UNKNOWN_LOBBY: {
      code: 10031,
      message: 'Unknown Lobby',
    },
    UNKNOWN_BRANCH: {
      code: 10032,
      message: 'Unknown Branch',
    },
    UNKNOWN_REDISTRIBUTABLE: {
      code: 10036,
      message: 'Unknown Redistributable',
    },
    UNKNOWN_GIFT_CODE: {
      code: 10038,
      message: 'Unknown Gift Code',
    },
    UNKNOWN_TEAM: {
      code: 10039,
      message: 'Unknown Team',
    },
    UNKNOWN_SUBSCRIPTION_PLAN: {
      code: 10073,
      message: 'Unknown Subscription Plan',
    },
    UNKNOWN_BOT: {
      code: 10500,
      message: 'Unknown Bot',
    },
    UNKNOWN_REPORT: {
      code: 521001, // official undocumented Discord error DSA_RSL_REPORT_NOT_FOUND repurposed for Oldcord admin panel report system
      message: 'Unknown Report',
    },
  },
  response_405: {
    METHOD_NOT_ALLOWED: {
      code: 0,
      message: '405: Method Not Allowed',
    },
  },
  response_500: {
    INTERNAL_SERVER_ERROR: {
      code: 0,
      message: '500: Internal Server Error',
    },
  },
  response_502: {
    BAD_GATEWAY: {
      code: 0,
      message: '502: Bad Gateway',
    },
  },
  response_429: {
    SLOWMODE_RATE_LIMIT: {
      code: 20016,
      message: 'This action cannot be performed due to slowmode rate limit',
    },
    RATE_LIMITED: {
      code: 31001,
      message: 'You are being rate limited',
    },
    RESOURCE_RATE_LIMITED: {
      code: 31002,
      message: 'The resource is being rate limited',
    },
    WATCHDOG_BLOCKED: {
      code: 31003,
      message:
        'You have been blocked by the Watchdog of this instance. Contact the admins to appeal.',
    },
  },
};

export const {
  response_400,
  response_401,
  response_403,
  response_404,
  response_405,
  response_500,
  response_502,
  response_429,
} = errors;

export default errors;
