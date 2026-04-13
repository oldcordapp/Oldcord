import { compareSync, genSalt, hash } from 'bcrypt';
import {
  existsSync,
  promises as fsPromises,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { totp } from 'speakeasy';

import md5 from '../helpers/md5.ts';
import { dispatchEventInChannel, dispatchEventInGuild } from './dispatcher.js';
import { generateMsgEmbeds } from './embedder.js';
import {
  config,
  formatMessage,
  generateMemorableInviteCode,
  generateString,
  generateToken,
  getGuildOnlineUserIds,
  getUserPresence,
  miniUserObject,
  parseMentions,
  prepareAccountObject,
  SerializeOverwritesToString,
  usersToIDs,
} from './utils/globalutils.js';
import { logText } from './utils/logger.ts';
import { deconstruct, generate } from './utils/snowflake.js';

const db_config = config.db_config;

const pool = new Pool(db_config);

const cache = {};

async function runQuery(queryString, values = []) {
  //ngl chat gpt helped me fix the caching on this - and suggested i used multiple clients from a pool instead, hopefully this does something useful lol
  // TODO pls refactor all this shit my brain will explode help

  const query = {
    text: queryString,
    values: values,
  };

  const cacheKey = JSON.stringify(query);

  const client = await pool.connect();

  let isWriteQuery = false;

  try {
    isWriteQuery = /INSERT\s+INTO|UPDATE|DELETE\s+FROM/i.test(queryString);

    if (isWriteQuery) await client.query('BEGIN');

    if (/SELECT\s+\*\s+FROM/i.test(queryString)) {
      if (cache[cacheKey]) {
        return cache[cacheKey];
      }
    }

    if (isWriteQuery) {
      const tableNameMatch = queryString.match(/(?:FROM|INTO|UPDATE)\s+(\S+)/i);
      const tableName = tableNameMatch ? tableNameMatch[1] : null;

      if (tableName) {
        for (const key in cache) {
          if (key.includes(tableName)) {
            delete cache[key];
          }
        }
      }
    }

    const result = await client.query(query);
    const rows = result.rows;

    if (/SELECT\s+\*\s+FROM/i.test(queryString) && rows.length > 0) {
      cache[cacheKey] = rows;
    }

    if (isWriteQuery) {
      await client.query('COMMIT');
    }

    return rows.length === 0 ? null : rows;
  } catch (error) {
    if (isWriteQuery) {
      await client.query('ROLLBACK');
    }

    logText(
      `Error with query: ${queryString}, values: ${JSON.stringify(values)} - ${error}`,
      'error',
    );

    return null;
  } finally {
    client.release();
  }
}

async function doescolumnExist(column, table) {
  const check = await database.runQuery(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2) AS column_exists;`,
    [table, column],
  );

  return check[0].column_exists;
}

async function performMigrations() {
  const v = await database.runQuery(`SELECT * FROM instance_info;`);

  if (v[0].version != database.version) {
    //auto migrate for the time being
    const value = await database.runQuery(`SELECT * FROM users;`, [], true);

    if (value === null) {
      return;
    }

    if (!value[0].relationships) {
      await runQuery(`CREATE TABLE IF NOT EXISTS instance_info (version FLOAT);`, []);
      await runQuery(
        `INSERT INTO instance_info (version) SELECT ($1) WHERE NOT EXISTS (SELECT 1 FROM instance_info);`,
        [0.2],
      ); //safeguards, in case the script is run outside of the instance executing it
      await runQuery(`UPDATE instance_info SET version = $1 WHERE version = 0.1`, [0.2]);

      return;
    }

    logText(
      `Found outdated database setup, migrating to newer version... (${databaseVersion})`,
      'OLDCORD',
    ); //im lazy

    await runQuery(
      `CREATE TABLE IF NOT EXISTS relationships (user_id_1 TEXT, type SMALLINT, user_id_2 TEXT)`,
      [],
    );

    let relationships = value
      .map((i) => {
        return { id: i.id, rel: JSON.parse(i.relationships).filter((i) => i.type != 3) };
      })
      .filter((i) => i.rel.length != 0);

    const ignore = [];

    relationships.map((i) => {
      i.rel.map((r) => {
        if (
          JSON.stringify(ignore).includes(`["${r.id}","${i.id}"]`) ||
          JSON.stringify(ignore).includes(`["${r.id}","${i.id}"]`)
        ) {
          r.type = 0;
          return r;
        }

        if (r.type != 2) {
          ignore.push([i.id, r.id]);
          if (r.type === 4) {
            r.type = 3;
          }
        }
        return r;
      });

      i.rel = i.rel.filter((r) => r.type != 0);

      return i;
    });

    relationships = relationships.filter((i) => i.rel.length != 0);

    const insert = [];

    relationships.map((i) => i.rel.map((r) => insert.push([i.id, r.type, r.id])));

    await runQuery(`ALTER TABLE users DROP COLUMN relationships;`, []);

    insert.map(async (i) => {
      await runQuery(`INSERT INTO relationships VALUES ($1, $2, $3);`, [i[0], i[1], i[2]]);
    }); //TODO: Call a separate script to check how many versions out of date the current database is and run the required migration scripts

    logText(`Migrated`, 'OLDCORD'); //im lazy
  }
}

// TODO: turn this into exports
const database = {
  version: 0.2,
  runQuery,
  doescolumnExist,
  setupDatabase: async () => {
    try {
      await database.runQuery(
        `CREATE TABLE IF NOT EXISTS instance_info (version FLOAT, dm_restriction_applied BOOLEAN DEFAULT FALSE);`,
        [],
      );

      await database.runQuery(
        `INSERT INTO instance_info (version, dm_restriction_applied) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM instance_info);`,
        [0.2, false],
      );

      const columnExists = await database.doescolumnExist(
        'instance_info',
        'dm_restriction_applied',
      );
      if (!columnExists) {
        await database.runQuery(
          `ALTER TABLE instance_info ADD COLUMN dm_restriction_applied BOOLEAN DEFAULT FALSE;`,
        );
      }

      await performMigrations();

      await database.runQuery(
        `
                CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT,
                discriminator TEXT,
                email TEXT,
                password TEXT,
                token TEXT,
                verified BOOLEAN DEFAULT FALSE,
                claimed BOOLEAN DEFAULT TRUE,
                mfa_enabled BOOLEAN DEFAULT FALSE,
                mfa_secret TEXT DEFAULT NULL,
                premium BOOLEAN DEFAULT FALSE,
                created_at TEXT DEFAULT NULL,
                avatar TEXT DEFAULT NULL,
                bot BOOLEAN DEFAULT FALSE,
                flags INTEGER DEFAULT 0,
                registration_ip TEXT DEFAULT NULL,
                email_token TEXT DEFAULT NULL,
                last_login_ip TEXT DEFAULT NULL,
                private_channels TEXT DEFAULT '[]',
                settings TEXT DEFAULT '{"show_current_game":false,"inline_attachment_media":true,"inline_embed_media":true,"render_embeds":true,"render_reactions":true,"sync":true,"theme":"dark","enable_tts_command":true,"message_display_compact":false,"locale":"en-US","convert_emoticons":true,"restricted_guilds":[],"allow_email_friend_request":false,"friend_source_flags":{"all":true},"developer_mode":true,"guild_positions":[],"detect_platform_accounts":false,"status":"online"}',
                guild_settings TEXT DEFAULT '[]',
                disabled_until TEXT DEFAULT NULL,
                disabled_reason TEXT DEFAULT NULL
           );`,
        [],
      ); // 4 = Everyone, 3 = Friends of Friends & Server Members, 2 = Friends of Friends, 1 = Server Members, 0 = No one

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS relationships (
	        user_id_1 TEXT,
            type INT,
            user_id_2 TEXT
            );`,
        [],
      ); //User ID 1 will always be the user that initially establishes the relationship. Internally, the type will always be 3 for both incoming and outgoing FRs to avoid inserting 2 columns for one relationship. Checking whether the user id is in column 1 will also be the way to determine blocked users.

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS user_notes (
                author_id TEXT,
                user_id TEXT,
                note TEXT DEFAULT NULL
            );`,
        [],
      );

      // fix weird message bug for NULL messages
      await database.runQuery(
        `
        -- Check how many are affected
        -- SELECT COUNT(*) FROM channels WHERE guild_id = 'NULL';
        
        -- Fix them all
        UPDATE channels SET guild_id = NULL WHERE guild_id = 'NULL';
        `,
        [],
      );
      
      //never doing user -> nitro subscriptions, so this needs to be clarified.
      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS guild_subscriptions (
                guild_id TEXT,
                user_id TEXT,
                subscription_id TEXT,
                ended BOOLEAN DEFAULT FALSE
            );`,
        [],
      );

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS dm_channels (
                id TEXT,
                user1 TEXT,
                user2 TEXT
            );`,
        [],
      );

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS group_channels (
                id TEXT,
                icon TEXT DEFAULT NULL,
                name TEXT DEFAULT NULL,
                owner_id TEXT DEFAULT NULL,
                recipients TEXT DEFAULT '[]'
            );`,
        [],
      );

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS staff (
                user_id TEXT,
                privilege INTEGER DEFAULT 1,
                audit_log TEXT DEFAULT '[]'
            );`,
        [],
      ); //PRIVILEGE: 1 - (JANITOR) [Can only flag things for review], 2 - (MODERATOR) [Can only delete messages, mute users, and flag things for review], 3 - (ADMIN) [Free reign, can review flags, disable users, delete servers, etc], 4 - (INSTANCE OWNER) - [Can add new admins, manage staff, etc]

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS connected_accounts (
                user_id TEXT,
                account_id TEXT,
                username TEXT,
                visibility BOOLEAN DEFAULT FALSE,
                friendSync BOOLEAN DEFAULT TRUE,
                integrations TEXT DEFAULT '[]',
                revoked BOOLEAN DEFAULT FALSE,
                connected_at TEXT DEFAULT NULL,
                platform TEXT DEFAULT NULL
           );`,
        [],
      );

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS channels (
                id TEXT,
                type INTEGER DEFAULT 0,
                guild_id TEXT,
                parent_id TEXT DEFAULT NULL,
                topic TEXT DEFAULT NULL,
                last_message_id TEXT DEFAULT '0',
                permission_overwrites TEXT,
                name TEXT,
                nsfw BOOLEAN DEFAULT FALSE,
                rate_limit_per_user INTEGER DEFAULT 0,
                user_limit INTEGER DEFAULT 0,
                bitrate INTEGER DEFAULT 64000,
                position INTEGER DEFAULT 0
           );`,
        [],
      ); //type 0, aka "text", 1 for "dm", 2 for "voice" - and so on and so forth

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS permissions (
                channel_id TEXT,
                overwrite TEXT DEFAULT NULL
           );`,
        [],
      );

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS guilds (
                id TEXT PRIMARY KEY,
                name TEXT,
                icon TEXT DEFAULT NULL,
                splash TEXT DEFAULT NULL,
                banner TEXT DEFAULT NULL,
                region TEXT DEFAULT NULL,
                owner_id TEXT,
                afk_channel_id TEXT DEFAULT NULL,
                system_channel_id TEXT DEFAULT NULL,
                afk_timeout INTEGER DEFAULT 300,
                creation_date TEXT,
                exclusions TEXT DEFAULT '[]',
                custom_emojis TEXT DEFAULT '[]',
                webhooks TEXT DEFAULT '[]',
                features TEXT DEFAULT '[]',
                vanity_url TEXT DEFAULT NULL,
                default_message_notifications INTEGER DEFAULT 0,
                verification_level INTEGER DEFAULT 0,
                explicit_content_filter INTEGER DEFAULT 0,
                premium_tier INTEGER DEFAULT 0,
                premium_subscription_count INTEGER DEFAULT 0,
                premium_progress_bar_enabled BOOLEAN DEFAULT FALSE
           );`,
        [],
      );

      await database.runQuery(
        `
           CREATE TABLE IF NOT EXISTS applications (
               id TEXT PRIMARY KEY,
               owner_id TEXT,
               name TEXT DEFAULT 'My Application',
               icon TEXT DEFAULT NULL,
               secret TEXT DEFAULT NULL,
               description TEXT DEFAULT NULL
          );`,
        [],
      );

      await database.runQuery(
        `
          CREATE TABLE IF NOT EXISTS bots (
              id TEXT PRIMARY KEY,
              application_id TEXT,
              username TEXT,
              discriminator TEXT,
              avatar TEXT DEFAULT NULL,
              public BOOLEAN DEFAULT TRUE,
              require_code_grant BOOLEAN DEFAULT FALSE,
              token TEXT DEFAULT NULL
         );`,
        [],
      );

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS roles (
                guild_id TEXT,
                role_id TEXT,
                name TEXT,
                hoist BOOLEAN DEFAULT FALSE,
                color INTEGER DEFAULT 0,
                mentionable BOOLEAN DEFAULT FALSE,
                permissions INTEGER DEFAULT 104193089,
                position INTEGER DEFAULT 0
           );`,
        [],
      );

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS members (
                guild_id TEXT,
                user_id TEXT,
                nick TEXT DEFAULT NULL,
                roles TEXT DEFAULT '[]',
                joined_at TEXT DEFAULT NULL,
                deaf BOOLEAN DEFAULT FALSE,
                mute BOOLEAN DEFAULT FALSE
           );`,
        [],
      );

      await database.runQuery(
        `
            CREATE TABLE IF NOT EXISTS invites (
                guild_id TEXT,
                channel_id TEXT,
                code TEXT,
                temporary BOOLEAN DEFAULT FALSE,
                revoked BOOLEAN DEFAULT FALSE,
                inviter_id TEXT,
                uses INTEGER DEFAULT 0,
                maxUses INTEGER DEFAULT 0,
                maxAge INTEGER DEFAULT 0,
                xkcdpass BOOLEAN DEFAULT FALSE,
                createdAt TEXT
           );`,
        [],
      );

      await database.runQuery(
        `CREATE TABLE IF NOT EXISTS messages (
                type INTEGER DEFAULT 0,
                guild_id TEXT,
                message_id TEXT,
                channel_id TEXT,
                author_id TEXT,
                content TEXT,
                edited_timestamp TEXT DEFAULT NULL,
                mention_everyone BOOLEAN DEFAULT FALSE,
                nonce TEXT,
                timestamp TEXT,
                tts BOOLEAN DEFAULT FALSE,
                embeds TEXT DEFAULT '[]',
                reactions TEXT DEFAULT '[]',
                pinned BOOLEAN DEFAULT FALSE,
                overrides TEXT DEFAULT NULL
           );`,
        [],
      );

      await database.runQuery(
        `CREATE TABLE IF NOT EXISTS acknowledgements (
                user_id TEXT,
                channel_id TEXT,
                message_id TEXT,
                timestamp TEXT,
                mention_count INTEGER DEFAULT 0,
                last_pin_timestamp TEXT DEFAULT '0',
                UNIQUE(user_id, channel_id)
           );`,
        [],
      );

      await database.runQuery(
        `CREATE TABLE IF NOT EXISTS attachments (
                attachment_id TEXT,
                message_id TEXT,
                filename TEXT,
                height INTEGER,
                width INTEGER,
                size INTEGER,
                url TEXT
           );`,
        [],
      );

      await database.runQuery(
        `CREATE TABLE IF NOT EXISTS widgets (
                guild_id TEXT,
                channel_id TEXT DEFAULT NULL,
                enabled BOOLEAN DEFAULT FALSE
           );`,
        [],
      );

      await database.runQuery(
        `CREATE TABLE IF NOT EXISTS bans (
                guild_id TEXT,
                user_id TEXT
           );`,
        [],
      );

      await database.runQuery(
        `CREATE TABLE IF NOT EXISTS webhooks (
                guild_id TEXT,
                channel_id TEXT,
                id TEXT,
                token TEXT,
                avatar TEXT DEFAULT NULL,
                name TEXT DEFAULT 'Captain Hook',
                creator_id TEXT
            );`,
        [],
      );

      await database.runQuery(
        `CREATE TABLE IF NOT EXISTS webhook_overrides (
                id TEXT,
                override_id TEXT,
                avatar_url TEXT DEFAULT NULL,
                username TEXT DEFAULT NULL
            );`,
        [],
      );

      await database.runQuery(
        `CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                guild_id TEXT,
                action_type INTEGER,
                target_id TEXT,
                user_id TEXT,
                changes JSONB
            );`,
        [],
      );

      await database.runQuery(
        `CREATE TABLE IF NOT EXISTS instance_reports (
                id TEXT PRIMARY KEY,
                problem TEXT,
                subject TEXT,
                description TEXT,
                email_address TEXT DEFAULT NULL,
                action TEXT DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
        [],
      );

      await database.runQuery(
        `CREATE TABLE IF NOT EXISTS mfa_login_tickets (
                user_id TEXT,
                mfa_ticket TEXT DEFAULT NULL
            );`,
        [],
      );

      const instance_reports_exists = await database.doescolumnExist('action', 'instance_reports');

      if (!instance_reports_exists) {
        await database.runQuery(
          `ALTER TABLE instance_reports ADD COLUMN action TEXT DEFAULT 'PENDING';`,
        );
        await database.runQuery(
          `ALTER TABLE instance_reports ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`,
        );
      } else {
        await database.runQuery(
          `DELETE FROM instance_reports WHERE created_at < NOW() - INTERVAL '1 month';`,
        ); //Remove reports older than 1 month to free up db
      }

      const mfa_exists = await database.doescolumnExist('mfa_secret', 'users');

      if (!mfa_exists) {
        await database.runQuery(`ALTER TABLE users ADD COLUMN mfa_secret TEXT DEFAULT NULL`);
        await database.runQuery(`ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN DEFAULT FALSE`);
      }

      const msg_type_exists = await database.doescolumnExist('type', 'messages');

      if (!msg_type_exists) {
        await database.runQuery(`ALTER TABLE messages ADD COLUMN type INTEGER DEFAULT 0`);
      } //Can you really believe we've had no type property for over 4 years?

      const system_channel_id_exists = await database.doescolumnExist(
        'system_channel_id',
        'guilds',
      );

      if (!system_channel_id_exists) {
        await database.runQuery(
          `ALTER TABLE guilds ADD COLUMN system_channel_id TEXT DEFAULT NULL`,
        );
        await database.runQuery(
          `ALTER TABLE guilds ADD COLUMN explicit_content_filter INTEGER DEFAULT 0`,
        );
      }

      const rate_limit_exists_and_user_limit = await database.doescolumnExist(
        'rate_limit_per_user',
        'channels',
      );

      if (!rate_limit_exists_and_user_limit) {
        await database.runQuery(
          `ALTER TABLE channels ADD COLUMN rate_limit_per_user INTEGER DEFAULT 0`,
        );
        await database.runQuery(`ALTER TABLE channels ADD COLUMN user_limit INTEGER DEFAULT 0`);
        await database.runQuery(`ALTER TABLE channels ADD COLUMN bitrate INTEGER DEFAULT 64000`);
      }

      const last_pin_timestamp_exists = await database.doescolumnExist(
        'last_pin_timestamp',
        'acknowledgements',
      );

      if (!last_pin_timestamp_exists) {
        await database.runQuery(`ALTER TABLE acknowledgements RENAME TO acknowledgements_old`, []);

        await database.runQuery(
          `CREATE TABLE acknowledgements (
                    user_id TEXT,
                    channel_id TEXT,
                    message_id TEXT,
                    timestamp TEXT,
                    mention_count INTEGER DEFAULT 0,
                    last_pin_timestamp TEXT DEFAULT '0',
                    UNIQUE(user_id, channel_id)
                );`,
          [],
        );

        await database.runQuery(
          `
                    INSERT INTO acknowledgements (user_id, channel_id, message_id, timestamp, mention_count, last_pin_timestamp)
                    SELECT user_id, channel_id, MAX(message_id), MAX(timestamp), mention_count, last_pin_timestamp
                    FROM acknowledgements_old
                    GROUP BY user_id, channel_id
                `,
          [],
        );

        await database.runQuery(`DROP TABLE acknowledgements_old`, []);
      }

      const premium_tier_exists = await database.doescolumnExist('premium_tier', 'guilds');

      if (!premium_tier_exists) {
        await database.runQuery(`ALTER TABLE guilds ADD COLUMN premium_tier INTEGER DEFAULT 0`);
        await database.runQuery(
          `ALTER TABLE guilds ADD COLUMN premium_subscription_count INTEGER DEFAULT 0`,
        );
        await database.runQuery(
          `ALTER TABLE guilds ADD COLUMN premium_progress_bar_enabled BOOLEAN DEFAULT FALSE`,
        );
      }

      //#region Change 'NULL' to NULL defaults
      await database.runQuery(`
                UPDATE users
                SET
                    created_at = CASE WHEN created_at = 'NULL' THEN NULL ELSE created_at END,
                    avatar = CASE WHEN avatar = 'NULL' THEN NULL ELSE avatar END,
                    registration_ip = CASE WHEN registration_ip = 'NULL' THEN NULL ELSE registration_ip END,
                    email_token = CASE WHEN email_token = 'NULL' THEN NULL ELSE email_token END,
                    last_login_ip = CASE WHEN last_login_ip = 'NULL' THEN NULL ELSE last_login_ip END,
                    disabled_until = CASE WHEN disabled_until = 'NULL' THEN NULL ELSE disabled_until END,
                    disabled_reason = CASE WHEN disabled_reason = 'NULL' THEN NULL ELSE disabled_reason END
                WHERE
                    created_at = 'NULL' OR
                    avatar = 'NULL' OR
                    registration_ip = 'NULL' OR
                    email_token = 'NULL' OR
                    last_login_ip = 'NULL' OR
                    disabled_until = 'NULL' OR
                    disabled_reason = 'NULL';
            `);

      await database.runQuery(
        `
                UPDATE user_notes SET note = CASE WHEN note = 'NULL' THEN NULL ELSE note END WHERE note = 'NULL';
            `,
        [],
      );

      await database.runQuery(
        `
                UPDATE group_channels 
                SET
                    icon = CASE WHEN icon = 'NULL' THEN NULL ELSE icon END,
                    name = CASE WHEN name = 'NULL' THEN NULL ELSE name END,
                    owner_id = CASE WHEN owner_id = 'NULL' THEN NULL ELSE owner_id END
                WHERE icon = 'NULL' OR name = 'NULL' OR owner_id = 'NULL';
            `,
        [],
      );

      await database.runQuery(
        `
                UPDATE connected_accounts
                SET
                    connected_at = CASE WHEN connected_at = 'NULL' THEN NULL ELSE connected_at END,
                    platform = CASE WHEN platform = 'NULL' THEN NULL ELSE platform END
                WHERE connected_at = 'NULL' OR platform = 'NULL';
            `,
        [],
      );

      await database.runQuery(
        `
                UPDATE channels
                SET
                    parent_id = CASE WHEN parent_id = 'NULL' THEN NULL ELSE parent_id END,
                    topic = CASE WHEN topic = 'NULL' THEN NULL ELSE topic END
                WHERE parent_id = 'NULL' OR topic = 'NULL';    
            `,
        [],
      );

      await database.runQuery(
        `UPDATE permissions SET overwrite = CASE WHEN overwrite = 'NULL' THEN NULL ELSE overwrite END WHERE overwrite = 'NULL';`,
        [],
      );

      await database.runQuery(
        `
                UPDATE guilds
                SET
                    icon = CASE WHEN icon = 'NULL' THEN NULL ELSE icon END,
                    splash = CASE WHEN splash = 'NULL' THEN NULL ELSE splash END,
                    banner = CASE WHEN banner = 'NULL' THEN NULL ELSE banner END,
                    region = CASE WHEN region = 'NULL' THEN NULL ELSE region END,
                    vanity_url = CASE WHEN vanity_url = 'NULL' THEN NULL ELSE vanity_url END,
                    afk_channel_id = CASE WHEN afk_channel_id = 'NULL' THEN NULL ELSE afk_channel_id END
                WHERE icon = 'NULL' OR splash = 'NULL' OR banner = 'NULL' OR region = 'NULL' OR vanity_url = 'NULL' OR afk_channel_id = 'NULL';
            `,
        [],
      );

      await database.runQuery(
        `
                UPDATE applications
                SET
                    icon = CASE WHEN icon = 'NULL' THEN NULL ELSE icon END,
                    secret = CASE WHEN secret = 'NULL' THEN NULL ELSE secret END,
                    description = CASE WHEN description = 'NULL' THEN NULL ELSE description END
                WHERE icon = 'NULL' OR secret = 'NULL' OR description = 'NULL';
            `,
        [],
      );

      await database.runQuery(
        `
                UPDATE bots
                SET
                    avatar = CASE WHEN avatar = 'NULL' THEN NULL ELSE avatar END,
                    token = CASE WHEN token = 'NULL' THEN NULL ELSE token END
                WHERE avatar = 'NULL' OR token = 'NULL';
            `,
        [],
      );

      await database.runQuery(
        `
                UPDATE members
                SET
                    nick = CASE WHEN nick = 'NULL' THEN NULL ELSE nick END,
                    joined_at = CASE WHEN joined_at = 'NULL' THEN NULL ELSE joined_at END
                WHERE nick = 'NULL' OR joined_at = 'NULL';
            `,
        [],
      );

      await database.runQuery(
        `
                UPDATE messages
                SET
                    edited_timestamp = CASE WHEN edited_timestamp = 'NULL' THEN NULL ELSE edited_timestamp END,
                    overrides = CASE WHEN overrides = 'NULL' THEN NULL ELSE overrides END
                WHERE edited_timestamp = 'NULL' OR overrides = 'NULL';
            `,
        [],
      );

      await database.runQuery(
        `UPDATE widgets SET channel_id = CASE WHEN channel_id = 'NULL' THEN NULL ELSE channel_id END WHERE channel_id = 'NULL';`,
        [],
      );

      await database.runQuery(
        `UPDATE webhooks SET avatar = CASE WHEN avatar = 'NULL' THEN NULL ELSE avatar END WHERE avatar = 'NULL';`,
        [],
      );

      await database.runQuery(
        `
                UPDATE webhook_overrides
                SET
                    avatar_url = CASE WHEN avatar_url = 'NULL' THEN NULL ELSE avatar_url END,
                    username = CASE WHEN username = 'NULL' THEN NULL ELSE username END
                WHERE avatar_url = 'NULL' OR username = 'NULL';
            `,
        [],
      );

      await database.runQuery(
        `UPDATE instance_reports SET email_address = CASE WHEN email_address = 'NULL' THEN NULL ELSE email_address END WHERE email_address = 'NULL';`,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE users
                ALTER COLUMN created_at SET DEFAULT NULL,
                ALTER COLUMN avatar SET DEFAULT NULL,
                ALTER COLUMN registration_ip SET DEFAULT NULL,
                ALTER COLUMN email_token SET DEFAULT NULL,
                ALTER COLUMN last_login_ip SET DEFAULT NULL,
                ALTER COLUMN disabled_until SET DEFAULT NULL,
                ALTER COLUMN disabled_reason SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE user_notes
                ALTER COLUMN note SET DEFAULT NULL;
            `,
        [],
      );

      const checkRes = await database.runQuery(`
                    SELECT constraint_name
                    FROM information_schema.table_constraints
                    WHERE table_name = 'mfa_login_tickets'
                        AND constraint_name = 'mfa_login_tickets_pkey';
                    `);

      if (checkRes || (Array.isArray(checkRes) && checkRes.length > 0)) {
        await database.runQuery(
          `ALTER TABLE mfa_login_tickets DROP CONSTRAINT mfa_login_tickets_pkey;`,
        );
      } //fix pkey issue with mfa login tickets

      await database.runQuery(
        `
                ALTER TABLE group_channels
                ALTER COLUMN icon SET DEFAULT NULL,
                ALTER COLUMN name SET DEFAULT NULL,
                ALTER COLUMN owner_id SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE connected_accounts
                ALTER COLUMN connected_at SET DEFAULT NULL,
                ALTER COLUMN platform SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE channels
                ALTER COLUMN parent_id SET DEFAULT NULL,
                ALTER COLUMN topic SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE permissions
                ALTER COLUMN overwrite SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE guilds
                ALTER COLUMN icon SET DEFAULT NULL,
                ALTER COLUMN splash SET DEFAULT NULL,
                ALTER COLUMN banner SET DEFAULT NULL,
                ALTER COLUMN region SET DEFAULT NULL,
                ALTER COLUMN afk_channel_id SET DEFAULT NULL,
                ALTER COLUMN vanity_url SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE applications
                ALTER COLUMN icon SET DEFAULT NULL,
                ALTER COLUMN secret SET DEFAULT NULL,
                ALTER COLUMN description SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE bots
                ALTER COLUMN avatar SET DEFAULT NULL,
                ALTER COLUMN token SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE members
                ALTER COLUMN nick SET DEFAULT NULL,
                ALTER COLUMN joined_at SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE messages
                ALTER COLUMN edited_timestamp SET DEFAULT NULL,
                ALTER COLUMN overrides SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE widgets
                ALTER COLUMN channel_id SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE webhooks
                ALTER COLUMN avatar SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE webhook_overrides
                ALTER COLUMN avatar_url SET DEFAULT NULL,
                ALTER COLUMN username SET DEFAULT NULL;
            `,
        [],
      );

      await database.runQuery(
        `
                ALTER TABLE instance_reports
                ALTER COLUMN email_address SET DEFAULT NULL;
            `,
        [],
      );
      //#endregion

      //#region Change INTEGER to BOOLEAN where deemed fit
      const booleanMigrationStuff = [
        { table: 'users', column: 'verified', default: false },
        { table: 'users', column: 'claimed', default: true },
        { table: 'users', column: 'mfa_enabled', default: false },
        { table: 'users', column: 'premium', default: true },
        { table: 'users', column: 'bot', default: false },
        { table: 'connected_accounts', column: 'visibility', default: false },
        { table: 'connected_accounts', column: 'friendSync', default: true },
        { table: 'connected_accounts', column: 'revoked', default: false },
        { table: 'channels', column: 'nsfw', default: false },
        { table: 'bots', column: 'public', default: true },
        { table: 'bots', column: 'require_code_grant', default: false },
        { table: 'roles', column: 'hoist', default: false },
        { table: 'roles', column: 'mentionable', default: false },
        { table: 'members', column: 'deaf', default: false },
        { table: 'members', column: 'mute', default: false },
        { table: 'invites', column: 'temporary', default: false },
        { table: 'invites', column: 'revoked', default: false },
        { table: 'invites', column: 'xkcdpass', default: false },
        { table: 'messages', column: 'mention_everyone', default: false },
        { table: 'messages', column: 'tts', default: false },
        { table: 'messages', column: 'pinned', default: false },
        { table: 'widgets', column: 'enabled', default: false },
      ];

      for (const item of booleanMigrationStuff) {
        const res = await database.runQuery(
          `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2;`,
          [item.table, item.column],
        );

        if (res && res[0].data_type === 'integer') {
          try {
            await database.runQuery(
              `
                            ALTER TABLE ${item.table} 
                            ALTER COLUMN ${item.column} DROP DEFAULT,
                            ALTER COLUMN ${item.column} TYPE BOOLEAN USING (${item.column}::integer::boolean),
                            ALTER COLUMN ${item.column} SET DEFAULT ${item.default ? 'TRUE' : 'FALSE'};
                        `,
              [],
            );
          } catch (err) {}
        }
      }

      //#endregion

      //#region fix an oopsie
      await database.runQuery(
        `
                DELETE FROM messages 
                WHERE guild_id::text LIKE '{"id":%';
            `,
        [],
      );

      //#endregion

      await database.runQuery(
        `INSERT INTO channels (id, type, guild_id, parent_id, topic, last_message_id, permission_overwrites, name, position)
                SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
                WHERE NOT EXISTS (SELECT 1 FROM channels WHERE id = $1)`,
        [
          '643945264868098049',
          0,
          '643945264868098049',
          '[OVERRIDENTOPIC]',
          null,
          '0',
          null,
          'please-read-me',
          0,
        ],
      );

      await database.runQuery(
        `INSERT INTO messages (guild_id, message_id, channel_id, author_id, content, edited_timestamp, mention_everyone, nonce, timestamp, tts, embeds)
                SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
                WHERE NOT EXISTS (SELECT 1 FROM messages WHERE message_id = $2)`,
        [
          '643945264868098049',
          '643945264868098049',
          '643945264868098049',
          '643945264868098049',
          `Hey! It looks like you're using a client build that isn't supported by this guild. Your current build is from [YEAR] (if this shows the current year, you are either running a third party client or mobile client). Please check the channel topic or guild name for more details.`,
          null,
          0,
          '643945264868098049',
          new Date().toISOString(),
          0,
          '[]',
        ],
      );

      await database.runQuery(
        `INSERT INTO users (id, username, discriminator, email, password, token, created_at, avatar, bot, flags)
                SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
                WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = $1)`,
        [
          '643945264868098049',
          'Oldcord',
          '0000',
          'system@oldcordapp.com',
          'aLq6abXnklLRql3MEEpEHge4F9j3cE',
          null,
          new Date().toISOString(),
          null,
          1,
          4096,
        ],
      );

      await database.runQuery(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

      await database.runQuery(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS trgm_index_messages_content ON messages USING GIN (lower(content) gin_trgm_ops);`,
      );

      const infoRows = await database.runQuery(
        `SELECT dm_restriction_applied FROM instance_info LIMIT 1`,
      );
      const dmRestrictionApplied =
        infoRows && infoRows.length > 0 ? infoRows[0].dm_restriction_applied : false;

      if (config.require_friendship_for_dm || config.instance.flags.includes('FRIENDSHIP_FOR_DM')) {
        if (!dmRestrictionApplied) {
          const users = await database.runQuery(`SELECT id, settings FROM users WHERE bot = false`);

          if (users) {
            for (const user of users) {
              const settings = JSON.parse(user.settings);
              let changed = false;

              if (
                settings.default_guilds_restricted === false ||
                settings.default_guilds_restricted === undefined
              ) {
                settings.default_guilds_restricted = true;
                changed = true;
              }

              if (settings.friend_source_flags) {
                if (settings.friend_source_flags.all !== false) {
                  settings.friend_source_flags.all = false;
                  changed = true;
                }
                if (settings.friend_source_flags.mutual_friends !== true) {
                  settings.friend_source_flags.mutual_friends = true;
                  changed = true;
                }
                if (settings.friend_source_flags.mutual_guilds !== true) {
                  settings.friend_source_flags.mutual_guilds = true;
                  changed = true;
                }
              } else {
                settings.friend_source_flags = {
                  all: false,
                  mutual_friends: true,
                  mutual_guilds: true,
                };
                changed = true;
              }

              const userGuilds = await database.runQuery(
                `SELECT guild_id FROM members WHERE user_id = $1`,
                [user.id],
              );

              if (userGuilds) {
                for (const guilds of userGuilds) {
                  if (!settings.restricted_guilds.includes(guilds.guild_id)) {
                    settings.restricted_guilds.push(guilds.guild_id);
                    changed = true;
                  }
                }
              }

              if (changed) {
                await database.runQuery(`UPDATE users SET settings = $1 WHERE id = $2`, [
                  JSON.stringify(settings),
                  user.id,
                ]);
              }
            }
          }
          await database.runQuery(`UPDATE instance_info SET dm_restriction_applied = true`);
        }
      } else {
        if (dmRestrictionApplied) {
          await database.runQuery(`UPDATE instance_info SET dm_restriction_applied = false`);
        }
      }

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  internalDisableAccount: async (staff, user_id, disabled_until, audit_log_reason) => {
    try {
      if (user_id === staff.user_id || user_id === '643945264868098049') {
        return false;
      } // Safety net

      // If disabled_until is not provided, default to 'FOREVER'
      if (!disabled_until) {
        disabled_until = 'FOREVER';
      }

      await database.runQuery(
        `
                UPDATE users SET disabled_until = $1, disabled_reason = $2 WHERE id = $3
            `,
        [disabled_until, 'Spam', user_id],
      ); //to-do actually do this properly

      const audit_log = staff.audit_log;
      const moderation_id = generate();
      const deconstructed = deconstruct(moderation_id);
      const timestamp = deconstructed.date.toISOString();

      const audit_entry = {
        moderation_id: moderation_id,
        timestamp: timestamp,
        action: 'disable_user',
        moderated: {
          id: user_id,
          until_forever: disabled_until === 'FOREVER',
          until_when: disabled_until, // Storing the text 'FOREVER' or actual date in the audit log
        },
        reasoning: audit_log_reason,
      };

      audit_log.push(audit_entry);

      await database.updateInternalAuditLog(staff.user_id, audit_log);

      return audit_entry;
    } catch (error) {
      logText(error, 'error');
      return null;
    }
  },
  getInstanceReports: async (filter = 'PENDING') => {
    try {
      const rows = await database.runQuery(`SELECT * FROM instance_reports WHERE action = $1`, [
        filter,
      ]);

      if (rows === null || rows.length === 0) {
        return [];
      }

      const ret = [];

      for (var row of rows) {
        ret.push({
          id: row.id,
          problem: row.problem,
          subject: row.subject,
          description: row.description,
          email_address: row.email_address ?? null,
        });
      }

      return ret;
    } catch (error) {
      logText(error, 'error');
      return [];
    }
  },
  getUserSubscriptions: async (user_id) => {
    try {
      const query = `SELECT * FROM guild_subscriptions WHERE user_id = $1`;
      const params = [user_id];

      const rows = await database.runQuery(query, params);

      if (rows === null || rows.length === 0) {
        return [];
      }

      const ret = [];

      for (var row of rows) {
        ret.push({
          guild_id: row.guild_id,
          user_id: user_id,
          id: row.subscription_id,
          ended: row.ended,
        });
      }

      return ret;
    } catch (error) {
      logText(error, 'error');
      return [];
    }
  },
  getSubscription: async (subscription_id) => {
    try {
      const rows = await database.runQuery(
        `SELECT * FROM guild_subscriptions WHERE subscription_id = $1`,
        [subscription_id],
      );

      if (rows === null || rows.length === 0) {
        return null;
      }

      return {
        id: rows[0].subscription_id,
        guild_id: rows[0].guild_id,
        user_id: rows[0].user_id,
        ended: rows[0].ended,
      };
    } catch (error) {
      logText(error, 'error');
      return null;
    }
  },
  removeSubscription: async (subscription) => {
    try {
      const guild = await database.getGuildById(subscription.guild_id);

      if (!guild) {
        return false;
      }

      await database.runQuery(`DELETE FROM guild_subscriptions WHERE subscription_id = $1`, [
        subscription.id,
      ]);

      const new_sub_count = guild.premium_subscription_count - 1;
      let new_level = guild.premium_tier;
      const boostFeatures = ['ANIMATED_ICON', 'INVITE_SPLASH', 'BANNER', 'VANITY_URL'];
      const baseFeatures = (guild.features || []).filter((f) => !boostFeatures.includes(f));

      let earnedFeatures = [];

      if (new_sub_count >= 20 && new_level != 3) {
        //50 for august 2019 - 20 for september, odd
        new_level = 3;
        earnedFeatures = ['ANIMATED_ICON', 'INVITE_SPLASH', 'BANNER', 'VANITY_URL'];
      } else if (new_sub_count >= 10 && new_level != 2) {
        new_level = 2;
        earnedFeatures = ['ANIMATED_ICON', 'INVITE_SPLASH', 'BANNER'];
      } else if (new_sub_count >= 2 && new_level != 1) {
        new_level = 1;
        earnedFeatures = ['ANIMATED_ICON', 'INVITE_SPLASH'];
      }

      const finalFeatures = [...new Set([...baseFeatures, ...earnedFeatures])];

      guild.premium_subscription_count = new_sub_count;
      guild.premium_tier = new_level;
      guild.features = finalFeatures;

      await database.runQuery(
        `UPDATE guilds SET premium_subscription_count = $1, premium_tier = $2, features = $3 WHERE id = $4`,
        [new_sub_count, new_level, JSON.stringify(finalFeatures), guild.id],
      );

      await dispatchEventInGuild(guild, 'GUILD_UPDATE', guild);

      return true;
    } catch (error) {
      logText(error, 'error');
      return false;
    }
  },
  createGuildSubscription: async (user, guild) => {
    try {
      const subscription_id = generate();

      await database.runQuery(
        `INSERT INTO guild_subscriptions (guild_id, user_id, subscription_id, ended) VALUES ($1, $2, $3, $4)`,
        [guild.id, user.id, subscription_id, false],
      );

      const new_sub_count = guild.premium_subscription_count + 1;
      let new_level = guild.premium_tier;
      let msg_type = 8;
      const new_features = guild.features;

      const addFeatures = (newFeats) => {
        newFeats.forEach((f) => {
          if (!new_features.includes(f)) {
            new_features.push(f);
          }
        });
      };

      if (new_sub_count >= 2 && new_sub_count < 10 && new_level != 1) {
        new_level = 1;
        msg_type = 9;

        addFeatures(['ANIMATED_ICON', 'INVITE_SPLASH']);
      } else if (new_sub_count >= 10 && new_sub_count < 20 && new_level != 2) {
        new_level = 2;
        msg_type = 10;

        addFeatures(['ANIMATED_ICON', 'INVITE_SPLASH', 'BANNER', 'NEWS']);
      } else if (new_sub_count >= 20 && new_level != 3) {
        //50 for august 2019 - 20 for september, odd
        new_level = 3;
        msg_type = 11;

        addFeatures(['ANIMATED_ICON', 'INVITE_SPLASH', 'BANNER', 'NEWS', 'VANITY_URL']);
      }

      guild.premium_subscription_count = new_sub_count;
      guild.premium_tier = new_level;
      guild.features = new_features;

      await database.runQuery(
        `UPDATE guilds SET premium_subscription_count = $1, premium_tier = $2, features = $3 WHERE id = $4`,
        [new_sub_count, new_level, JSON.stringify(new_features), guild.id],
      );

      const system_msg = await global.database.createSystemMessage(
        guild.id,
        guild.system_channel_id,
        msg_type,
        [user],
      );

      await dispatchEventInChannel(guild, guild.system_channel_id, 'MESSAGE_CREATE', system_msg); //funny we're doing it here

      await dispatchEventInGuild(guild, 'GUILD_UPDATE', guild);

      return {
        id: subscription_id,
        guild_id: guild.id,
        user_id: user.id,
        ended: false,
      };
    } catch (error) {
      logText(error, 'error');
      return [];
    }
  },
  getGuildSubscriptions: async (guild) => {
    try {
      const rows = await database.runQuery(
        `SELECT * FROM guild_subscriptions WHERE guild_id = $1`,
        [guild.id],
      );

      if (rows === null || rows.length === 0) {
        return [];
      }

      const ret = [];

      for (var row of rows) {
        const member = guild.members.find((x) => x.id === row.user_id).user;

        ret.push({
          guild_id: guild.id,
          user_id: row.user_id,
          id: row.subscription_id,
          user: member,
          ended: row.ended,
        });
      }

      return ret;
    } catch (error) {
      logText(error, 'error');
      return [];
    }
  },
  getReportById: async (reportId) => {
    try {
      const rows = await database.runQuery(`SELECT * FROM instance_reports WHERE id = $1`, [
        reportId,
      ]);

      if (rows === null || rows.length === 0) {
        return null;
      }

      const row = rows[0];

      return {
        id: row.id,
        problem: row.problem,
        subject: row.subject,
        description: row.description,
        email_address: row.email_address ?? null,
        action: row.action,
      };
    } catch (error) {
      logText(error, 'error');
      return null;
    }
  },
  updateReport: async (reportId, action) => {
    try {
      const report = await database.getReportById(reportId);

      if (report == null || report.action !== 'PENDING') {
        return false;
      }

      await database.runQuery(`UPDATE instance_reports SET action = $1 WHERE id = $2`, [
        action,
        reportId,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');
      return false;
    }
  },
  submitInstanceReport: async (description, subject, problem, email_address = null) => {
    try {
      await database.runQuery(
        `INSERT INTO instance_reports (id, problem, subject, description, email_address, action) VALUES ($1, $2, $3, $4, $5, $6)`,
        [generate(), problem, subject, description, email_address, 'PENDING'],
      );

      return true;
    } catch (error) {
      logText(error, 'error');
      return false;
    }
  },
  internalDeleteAccount: async (staff, user_id, audit_log_reason) => {
    try {
      if (user_id === staff.user_id || user_id === '643945264868098049') {
        return false;
      } // Safety net

      await database.runQuery(`DELETE FROM users WHERE id = $1`, [user_id]); //figure out messages

      const audit_log = staff.audit_log;
      const moderation_id = generate();
      const deconstructed = deconstruct(moderation_id);
      const timestamp = deconstructed.date.toISOString();

      const audit_entry = {
        moderation_id: moderation_id,
        timestamp: timestamp,
        action: 'delete_user',
        moderated: {
          id: user_id,
        },
        reasoning: audit_log_reason,
      };

      audit_log.push(audit_entry);

      await database.updateInternalAuditLog(staff.user_id, audit_log);

      return audit_entry;
    } catch (error) {
      logText(error, 'error');
      return null;
    }
  },
  updateInternalAuditLog: async (staff_id, new_log) => {
    try {
      await database.runQuery(
        `
                UPDATE staff SET audit_log = $1 WHERE user_id = $2
            `,
        [JSON.stringify(new_log), staff_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  addToGuildAuditLogs: async (guild_id, action_type, target_id, user_id, changes) => {
    try {
      const audit_log_id = generate();

      await database.runQuery(
        `
                INSERT INTO audit_logs (id, guild_id, action_type, target_id, user_id, changes) VALUES ($1, $2, $3, $4, $5, $6)
            `,
        [audit_log_id, guild_id, action_type, target_id, user_id, changes],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  setPrivateChannels: async (user_id, private_channels) => {
    try {
      await database.runQuery(
        `
                UPDATE users SET private_channels = $1 WHERE id = $2
            `,
        [JSON.stringify(private_channels), user_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getGuildMemberByID: async (guild_id, user_id) => {
    try {
      const rows = await database.runQuery(
        `
               SELECT m.guild_id, m.user_id, m.nick, m.roles, m.joined_at, m.deaf, m.mute, u.username, u.discriminator, u.id as user_id_real, u.avatar, u.bot, u.flags FROM members AS m INNER JOIN users AS u ON u.id = m.user_id WHERE m.guild_id = $1 AND m.user_id = $2
            `,
        [guild_id, user_id],
      );

      if (rows === null || rows.length === 0) {
        return null;
      }

      const row = rows[0];

      const member = {
        id: row.user_id_real,
        nick: row.nick,
        deaf: row.deaf,
        mute: row.mute,
        roles: JSON.parse(row.roles) ?? [],
        joined_at: row.joined_at,
        user: {
          username: row.username,
          discriminator: row.discriminator,
          id: row.user_id_real,
          avatar: row.avatar,
          bot: row.bot,
          flags: row.flags,
          premium: true,
        },
      };

      return member;
    } catch (error) {
      logText(error, 'error');
      return null;
    }
  },
  op8getGuildMemberChunks: async (guildId, usernameQuery, userLimit, includePresences = false) => {
    try {
      const rows = await database.runQuery(
        `SELECT 
          m.guild_id, m.user_id, m.nick, m.roles, m.joined_at, m.deaf, m.mute, 
          u.username, u.discriminator, u.id AS user_id_real, u.avatar, u.bot, u.flags 
        FROM members AS m 
        INNER JOIN users AS u ON u.id = m.user_id 
        WHERE m.guild_id = $1 
        AND (u.username ILIKE $2 || '%' OR m.nick ILIKE $2 || '%')
        LIMIT $3`,
        [guildId, usernameQuery, userLimit || 10],
      );

      if (!rows || rows.length === 0) {
        return { members: [], presences: [], chunk_index: 0, chunk_count: 1 };
      }

      const members = [];
      const presences = [];

      for (const row of rows) {
        const miniUser = {
          username: row.username,
          discriminator: row.discriminator,
          id: row.user_id_real,
          avatar: row.avatar,
          bot: row.bot,
          flags: row.flags,
          premium: true,
        };

        const member = {
          user: miniUser,
          nick: row.nick,
          roles: JSON.parse(row.roles) ?? [],
          joined_at: row.joined_at,
          deaf: row.deaf,
          mute: row.mute,
        };

        members.push(member);

        if (includePresences) {
          const sessions = global.userSessions.get(row.user_id_real);

          let presence = {
            user: { id: row.user_id_real },
            status: 'offline',
            activities: [],
            client_status: {},
          };

          if (sessions && sessions.length > 0) {
            const session = sessions[sessions.length - 1];

            if (session.presence) {
              presence = session.presence;
            }
          }
          presences.push(presence);
        }
      }

      return {
        members: members,
        presences: presences,
        chunk_index: 0,
        chunk_count: 1,
      };
    } catch (error) {
      logText(error, 'error');
      return { members: [], presences: [], chunk_index: 0, chunk_count: 1 };
    }
  },
  op12getGuildMembersAndPresences: async (guild) => {
    try {
      if (guild && guild.members.length !== 0) {
        return {
          members: guild.members,
          presences: guild.presences,
        };
      }

      const rows = await database.runQuery(
        `SELECT m.guild_id, m.user_id, m.nick, m.roles, m.joined_at, m.deaf, m.mute, u.username, u.discriminator, u.id AS user_id_real, u.avatar, u.bot, u.flags FROM members AS m INNER JOIN users AS u ON u.id = m.user_id WHERE m.guild_id = $1`,
        [guild.id],
      );

      if (rows === null || rows.length === 0) {
        return { members: [], presences: [] };
      }

      const members = [];
      const presences = [];
      let offlineCount = 0;

      const guildRoles = guild.roles;

      if (!guildRoles || guildRoles.length == 0) {
        return { members: [], presences: [] };
      }

      for (var row of rows) {
        const miniUser = {
          username: row.username,
          discriminator: row.discriminator,
          id: row.user_id_real,
          avatar: row.avatar,
          bot: row.bot,
          flags: row.flags,
          premium: true,
        };

        let member_roles = JSON.parse(row.roles) ?? [];

        if (guildRoles && guildRoles.length > 0) {
          member_roles = member_roles.filter(
            (role_id) => guildRoles.find((guild_role) => guild_role.id === role_id) !== undefined,
          );
        }

        const member = {
          id: row.user_id_real,
          nick: row.nick,
          deaf: row.deaf,
          mute: row.mute,
          roles: member_roles,
          joined_at: row.joined_at,
          user: miniUser,
        };

        const sessions = global.userSessions.get(member.id);
        let presenceStatus = 'offline';
        let presence = {
          game_id: null,
          status: presenceStatus,
          activities: [],
          user: miniUserObject(member.user),
        };

        if (sessions && sessions.length > 0) {
          const session = sessions[sessions.length - 1];

          if (session.presence) {
            presenceStatus = session.presence.status;
            presence = session.presence;
          }
        }

        if (presenceStatus === 'online' || presenceStatus === 'idle' || presenceStatus === 'dnd') {
          members.push(member);
          presences.push(presence);
        } else if (offlineCount <= 1000) {
          offlineCount++;
          members.push(member);
          presences.push(presence);
        }
      }

      return {
        members: members,
        presences: presences,
      };
    } catch (error) {
      logText(error, 'error');

      return { members: [], presences: [] };
    }
  },
  getPrivateChannels: async (user_id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT private_channels FROM users WHERE id = $1 LIMIT 1
            `,
        [user_id],
      );

      if (rows == null || rows.length == 0) {
        return [];
      }

      return JSON.parse(rows[0].private_channels) ?? [];
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  },
  getBotPrivateChannels: async (bot_id) => {
    try {
      let channels = [];

      const rows = await database.runQuery(
        `
                SELECT id FROM dm_channels WHERE user1 = $1 OR user2 = $1
            `,
        [bot_id],
      );

      if (rows == null || rows.length == 0) {
        return channels;
      }

      channels = rows.map((row) => row.id);

      return channels;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  },
  findPrivateChannel: async (user1_id, user2_id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT id FROM dm_channels WHERE (user1 = $1 AND user2 = $2) OR (user1 = $2 AND user2 = $1) LIMIT 1
            `,
        [user1_id, user2_id],
      );

      if (rows == null || rows.length == 0) return null;

      //TODO: Foul solution but more maintainable than copying and pasting -- fix up later
      return await database.getChannelById(rows[0].id);
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  }, //rewrite asap
  getLatestAcknowledgement: async (user_id, channel_id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT * FROM acknowledgements WHERE user_id = $1 AND channel_id = $2 ORDER BY message_id DESC LIMIT 1
            `,
        [user_id, channel_id],
      );

      if (rows == null || rows.length == 0) {
        return null;
      }

      return {
        id: rows[0].channel_id,
        mention_count: rows[0].mention_count || 0,
        last_message_id: rows[0].message_id,
        last_pin_timestamp: rows[0].last_pin_timestamp || '0', //to-do last pin timestamp
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  incrementMentions: async (channel_id, guild_id, mentionType) => {
    try {
      let userIds = [];

      if (mentionType === 'everyone') {
        const members = await database.runQuery(`SELECT user_id FROM members WHERE guild_id = $1`, [
          guild_id,
        ]);

        userIds = members.map((m) => m.user_id);
      } else if (mentionType === 'here') {
        userIds = getGuildOnlineUserIds(guild_id);
      }

      if (userIds.length === 0) return false;

      for (const uid of userIds) {
        await database.runQuery(
          `INSERT INTO acknowledgements (user_id, channel_id, mention_count, message_id) VALUES ($1, $2, 1, '0') ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = acknowledgements.mention_count + 1`,
          [uid, channel_id],
        );
      }

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getStaffDetails: async (user_id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT * FROM staff WHERE user_id = $1
            `,
        [user_id],
      );

      if (rows == null || rows.length == 0) {
        return null;
      }

      return {
        user_id: rows[0].user_id,
        privilege: rows[0].privilege,
        audit_log: JSON.parse(rows[0].audit_log) ?? [],
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getUserPremiumState: async (user_id) => {
    try {
      const r = await database.runQuery(
        `
        SELECT premium FROM users WHERE id = $1`,
        [user_id],
      );
      return { premium: r };
    } catch (error) {
      logText(error, 'error');
      return null;
    }
  },
  setUserPremium: async (user_id, v) => {
    const sameState = await database.getUserPremiumState(user_id);
    if (v === sameState) return v; // just return the same instead of reupdating it
    try {
      await database.runQuery(
        `
        UPDATE users SET premium = $1 WHERE id = $2`,
        [String(v), user_id],
      );
      return v;
    } catch (error) {
      logText(error, 'error');
      return null;
    }
  },
  isMessageAcked: async (user_id, channel_id, message_id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT EXISTS (
                    SELECT 1 FROM acknowledgements WHERE user_id = $1 AND channel_id = $2 AND message_id = $3
                ) AS is_acked;
            `,
        [user_id, channel_id, message_id],
      );

      return rows[0] ? rows[0].is_acked : false;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  acknowledgeMessage: async (
    user_id,
    channel_id,
    message_id,
    mention_count = 0,
    last_pin_timestamp = '0',
  ) => {
    try {
      const date = new Date().toISOString();

      await database.runQuery(
        `INSERT INTO acknowledgements (user_id, channel_id, message_id, mention_count, timestamp, last_pin_timestamp) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT(user_id, channel_id) DO UPDATE SET message_id = EXCLUDED.message_id, mention_count = EXCLUDED.mention_count, timestamp = EXCLUDED.timestamp, last_pin_timestamp = EXCLUDED.last_pin_timestamp`,
        [user_id, channel_id, message_id, mention_count, date, last_pin_timestamp],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getUsersGuildSettings: async (user_id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT * FROM users WHERE id = $1
            `,
        [user_id],
      );

      if (rows != null && rows.length > 0) {
        return JSON.parse(rows[0].guild_settings);
      } else {
        return null;
      }
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  setUsersGuildSettings: async (user_id, new_settings) => {
    try {
      await database.runQuery(`UPDATE users SET guild_settings = $1 WHERE id = $2`, [
        JSON.stringify(new_settings),
        user_id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getAccountByEmail: async (email) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT * FROM users WHERE email = $1
            `,
        [email],
      );

      return await prepareAccountObject(rows, []); //relationships arent even accessed from here either
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getAccountByToken: async (token) => {
    try {
      let rows = await database.runQuery(
        `
                    SELECT * FROM users WHERE token = $1
            `,
        [token],
      );

      if (!rows || rows.length == 0) {
        rows = await database.runQuery(
          `
                    SELECT * FROM bots WHERE token = $1
                `,
          [token.split('Bot ')[1] ?? token],
        );

        if (!rows || rows.length == 0) return null;

        return {
          avatar: rows[0].avatar,
          bot: true,
          discriminator: rows[0].discriminator,
          id: rows[0].id,
          token: rows[0].token,
          username: rows[0].username,
        };
      }

      const relationships = await global.database.getRelationshipsByUserId(rows[0].id);

      return prepareAccountObject(rows, relationships); //to-do fix
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  }, //rewrite asap
  getAccountByUsernameTag: async (username, discriminator) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT * FROM users WHERE username = $1 AND discriminator = $2
            `,
        [username, discriminator],
      );

      if (!rows || rows.length == 0) return null;

      if (rows === null || rows.length === 0) {
        return null;
      }

      const relationships = await global.database.getRelationshipsByUserId(rows[0].id);
      return await prepareAccountObject(rows, relationships); //to-do fix
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  }, //rewrite asap
  checkEmailToken: async (token) => {
    try {
      if (!token || token === null) {
        return null;
      }

      const rows = await database.runQuery(`SELECT * FROM users WHERE email_token = $1`, [token]);

      if (rows === null || rows.length === 0) {
        return null;
      }

      return {
        id: rows[0].id,
        verified: rows[0].verified,
        email_token: token,
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getEmailToken: async (id) => {
    try {
      const rows = await database.runQuery(`SELECT * FROM users WHERE id = $1`, [id]);

      if (rows === null || rows.length === 0) {
        return null;
      }

      return rows[0].email_token;
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  updateEmailToken: async (id, new_token) => {
    try {
      await database.runQuery(`UPDATE users SET email_token = $1 WHERE id = $2`, [new_token, id]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  useEmailToken: async (id, token) => {
    try {
      const check = await database.checkEmailToken(token);

      if (!check) {
        return false;
      }

      if (check.id !== id) {
        return false;
      }

      await database.runQuery(`UPDATE users SET email_token = $1, verified = $2 WHERE id = $3`, [
        null,
        1,
        id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  }, //rewrite asap
  getBotByUserId: async (id) => {
    try {
      if (!id) return null;

      const rows = await database.runQuery(
        `
                    SELECT * FROM bots WHERE id = $1
                `,
        [id],
      );

      if (rows === null || rows.length === 0) {
        return null;
      }

      const application = await database.getApplicationById(rows[0].application_id);

      if (application === null) {
        return null;
      }

      delete application.secret;

      return {
        avatar: rows[0].avatar,
        discriminator: rows[0].discriminator,
        username: rows[0].username,
        id: rows[0].id,
        public: rows[0].public,
        require_code_grant: rows[0].require_code_grant,
        application: application,
      };
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  }, //to-do deprecate this
  getAccountByUserId: async (id) => {
    try {
      if (!id) return null;

      if (id.startsWith('WEBHOOK_')) {
        const parts = id.split('_');
        const webhookId = parts[1];
        const webhook = await database.getWebhookById(webhookId);
        const webhookOverride = await database.getWebhookOverrides(
          id.split('_')[1],
          id.split('_')[2],
        );

        if (webhook) {
          return {
            id: webhookId,
            username: webhookOverride?.username || webhook.name,
            avatar: webhookOverride?.avatar_url || webhook.avatar,
            bot: true,
            webhook: true,
            premium: false,
            flags: 0,
            discriminator: '0000',
          };
        }

        return {
          id: webhookId,
          username: 'Deleted Webhook',
          avatar: null,
          bot: true,
          webhook: true,
          premium: false,
          flags: 0,
          discriminator: '0000',
        };
      }

      let rows = await database.runQuery(
        `
                SELECT * FROM users WHERE id = $1
            `,
        [id],
      );

      if (rows === null || rows.length === 0) {
        rows = await database.runQuery(
          `
                    SELECT * FROM bots WHERE id = $1
                `,
          [id],
        );

        if (rows === null || rows.length === 0) {
          return null;
        }
      }

      if (rows[0].require_code_grant != undefined) {
        return {
          avatar: rows[0].avatar,
          bot: true,
          discriminator: rows[0].discriminator,
          id: rows[0].id,
          token: rows[0].token,
          username: rows[0].username,
        };
      } else {
        const relationships = await global.database.getRelationshipsByUserId(rows[0].id);

        return await prepareAccountObject(rows, relationships);
      }
    } catch (error) {
      logText(error, 'error');

      return null;
    } //to-do fix
  }, //rewrite asap
  banMember: async (guild_id, user_id) => {
    try {
      await database.runQuery(
        `
                INSERT INTO bans (guild_id, user_id)
                SELECT $1, $2
                WHERE NOT EXISTS (
                    SELECT 1 FROM bans WHERE guild_id = $1 AND user_id = $2
                );
        `,
        [guild_id, user_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  unbanMember: async (guild_id, user_id) => {
    try {
      await database.runQuery(
        `
                DELETE FROM bans WHERE guild_id = $1 AND user_id = $2
            `,
        [guild_id, user_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  createCustomEmoji: async (guild, user, emoji_id, emoji_name) => {
    try {
      const custom_emojis = guild.emojis;

      custom_emojis.push({
        id: emoji_id,
        name: emoji_name,
        user: miniUserObject(user),
      });

      await database.runQuery(`UPDATE guilds SET custom_emojis = $1 WHERE id = $2`, [
        JSON.stringify(custom_emojis),
        guild.id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  updateCustomEmoji: async (guild, emoji_id, new_name) => {
    try {
      const custom_emojis = guild.emojis;

      const customEmoji = custom_emojis.find((x) => x.id == emoji_id);

      if (!customEmoji) {
        return false;
      }

      customEmoji.name = new_name;

      await database.runQuery(`UPDATE guilds SET custom_emojis = $1 WHERE id = $2`, [
        JSON.stringify(custom_emojis),
        guild.id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  deleteCustomEmoji: async (guild, emoji_id) => {
    try {
      let custom_emojis = guild.emojis;

      custom_emojis = custom_emojis.filter((x) => x.id != emoji_id);

      const emojiPath = `./www_dynamic/emojis`;

      if (existsSync(emojiPath)) {
        const files = readdirSync(emojiPath);
        const emotes = files.filter((x) => x.startsWith(`${emoji_id}.`));

        emotes.forEach((emote) => {
          try {
            unlinkSync(join(emojiPath, emote));
          } catch (error) {
            logText(
              `Failed to unlink custom guild emote file ${file} (guild -> ${guild.id}): ${err.message}`,
              'error',
            );
          }
        });
      }

      await database.runQuery(`UPDATE guilds SET custom_emojis = $1 WHERE id = $2`, [
        JSON.stringify(custom_emojis),
        guild.id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  updateWebhook: async (webhook, channel, name, avatar) => {
    try {
      if (!avatar) {
        avatar = null;
      }

      let finalAvatarValue = avatar;

      if (avatar != null && avatar.includes('data:image/')) {
        var extension = avatar.split('/')[1].split(';')[0];
        var imgData = avatar.replace(`data:image/${extension};base64,`, '');
        var file_name = generateString(30);
        var name_hash = md5(file_name);

        if (extension == 'jpeg') {
          extension = 'jpg';
        }

        finalAvatarValue = name_hash;

        if (!existsSync(`./www_dynamic/avatars/${webhook.id}`)) {
          mkdirSync(`./www_dynamic/avatars/${webhook.id}`, { recursive: true });
        }

        writeFileSync(
          `./www_dynamic/avatars/${webhook.id}/${name_hash}.${extension}`,
          imgData,
          'base64',
        );
      }

      webhook.name = name;
      webhook.avatar = finalAvatarValue;

      await database.runQuery(
        `UPDATE webhooks SET channel_id = $1, name = $2, avatar = $3 WHERE id = $4`,
        [channel.id, name, finalAvatarValue, webhook.id],
      );

      return webhook;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  deleteWebhook: async (webhook_id) => {
    try {
      await database.runQuery(`DELETE FROM webhooks WHERE id = $1`, [webhook_id]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  createWebhook: async (guild, user, channel_id, name, avatar) => {
    try {
      const webhook_id = generate();
      let avatarHash = null;

      if (avatar != null && avatar.includes('data:image/')) {
        var extension = avatar.split('/')[1].split(';')[0];
        var imgData = avatar.replace(`data:image/${extension};base64,`, '');
        var name = generateString(30);
        var name_hash = md5(name);

        avatarHash = name_hash;

        if (extension == 'jpeg') {
          extension = 'jpg';
        }

        if (!existsSync(`./www_dynamic/avatars/${webhook_id}`)) {
          mkdirSync(`./www_dynamic/avatars/${webhook_id}`, { recursive: true });
        }

        writeFileSync(
          `./www_dynamic/avatars/${webhook_id}/${name_hash}.${extension}`,
          imgData,
          'base64',
        );
      }

      const token = generateString(60);

      await database.runQuery(
        `INSERT INTO webhooks (guild_id, channel_id, id, token, avatar, name, creator_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [guild.id, channel_id, webhook_id, token, avatarHash, name, user.id],
      );

      return {
        application_id: null,
        id: webhook_id,
        token: token,
        avatar: avatarHash,
        name: name,
        channel_id: channel_id,
        guild_id: guild.id,
        type: 1,
        user: miniUserObject(user),
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getWebhookById: async (webhook_id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT w.*, u.username, u.discriminator, u.id as user_id, u.avatar as user_avatar, u.flags FROM webhooks AS w INNER JOIN users AS u ON w.creator_id = u.id WHERE w.id = $1
            `,
        [webhook_id],
      );

      if (rows != null && rows.length > 0) {
        const row = rows[0];

        return {
          guild_id: row.guild_id,
          channel_id: row.channel_id,
          id: row.id,
          token: row.token,
          avatar: row.avatar,
          name: row.name,
          user: {
            username: row.username,
            discriminator: row.discriminator,
            id: row.user_id,
            avatar: row.user_avatar,
            bot: false,
            flags: row.flags,
            premium: true,
          },
          type: 1,
          application_id: null,
        };
      } else {
        return null;
      }
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getConnectedAccounts: async (user_id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT * FROM connected_accounts WHERE user_id = $1
            `,
        [user_id],
      );

      if (rows != null && rows.length > 0) {
        const ret = [];

        for (var row of rows) {
          ret.push({
            id: row.account_id,
            type: row.platform,
            name: row.username,
            revoked: row.revoked,
            integrations: JSON.parse(row.integrations) ?? [],
            visibility: row.visibility,
            friendSync: row.friendSync,
          });
        }

        return ret;
      } else {
        return [];
      }
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  },
  validateTotpCode: async (user_id, code, overriden_secret = null) => {
    try {
      const mfa_status = await database.getUserMfa(user_id);

      if (!mfa_status.mfa_secret && !overriden_secret) {
        return false;
      }

      const valid = totp.verify({
        secret: mfa_status.mfa_secret || overriden_secret,
        encoding: 'base32',
        token: code,
      });

      return valid;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  generateMfaTicket: async (user_id) => {
    try {
      const ticket = generateString(40);

      await database.runQuery(
        `INSERT INTO mfa_login_tickets (user_id, mfa_ticket) VALUES ($1, $2)`,
        [user_id, ticket],
      );

      return ticket;
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  invalidateMfaTicket: async (ticket) => {
    try {
      await database.runQuery(`DELETE FROM mfa_login_tickets WHERE mfa_ticket = $1`, [ticket]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getLoginTokenByMfaTicket: async (ticket) => {
    try {
      const rows = await database.runQuery(
        `SELECT u.token FROM users AS u INNER JOIN mfa_login_tickets AS m ON m.user_id = u.id WHERE m.mfa_ticket = $1`,
        [ticket],
      );

      if (!rows || rows.length === 0) {
        return null;
      }

      return rows[0].token;
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getUserMfaByTicket: async (ticket) => {
    try {
      const rows = await database.runQuery(
        `SELECT u.mfa_enabled, u.mfa_secret FROM mfa_login_tickets AS m INNER JOIN users AS u ON m.user_id = u.id WHERE m.mfa_ticket = $1`,
        [ticket],
      );

      if (!rows || rows.length === 0) {
        return {
          mfa_enabled: false,
          mfa_secret: null,
        };
      }

      return {
        mfa_enabled: rows[0].mfa_enabled,
        mfa_secret: rows[0].mfa_secret,
      };
    } catch (error) {
      logText(error, 'error');

      return {
        mfa_enabled: false,
        mfa_secret: null,
      };
    }
  },
  getUserMfa: async (user_id) => {
    try {
      const rows = await database.runQuery(
        `SELECT mfa_enabled, mfa_secret FROM users WHERE id = $1`,
        [user_id],
      );

      if (!rows || rows.length === 0) {
        return {
          mfa_enabled: false,
          mfa_secret: null,
        };
      }

      return {
        mfa_enabled: rows[0].mfa_enabled,
        mfa_secret: rows[0].mfa_secret,
      };
    } catch (error) {
      logText(error, 'error');

      return {
        mfa_enabled: false,
        mfa_secret: null,
      };
    }
  },
  getUserMfaByToken: async (token) => {
    try {
      const rows = await database.runQuery(
        `SELECT mfa_enabled, mfa_secret FROM users WHERE token = $1`,
        [token],
      );

      if (!rows || rows.length === 0) {
        return {
          mfa_enabled: false,
          mfa_secret: null,
        };
      }

      return {
        mfa_enabled: rows[0].mfa_enabled,
        mfa_secret: rows[0].mfa_secret,
      };
    } catch (error) {
      logText(error, 'error');

      return {
        mfa_enabled: false,
        mfa_secret: null,
      };
    }
  },
  updateUserMfa: async (user_id, mfa_enabled, mfa_secret) => {
    try {
      await database.runQuery(`UPDATE users SET mfa_enabled = $1, mfa_secret = $2 WHERE id = $3`, [
        mfa_enabled,
        mfa_secret,
        user_id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');
      return false;
    }
  },
  getConnectionById: async (account_id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT * FROM connected_accounts WHERE account_id = $1
            `,
        [account_id],
      );

      if (rows != null && rows.length > 0) {
        return {
          id: rows[0].account_id,
          type: rows[0].platform,
          name: rows[0].username,
          revoked: rows[0].revoked,
          integrations: JSON.parse(rows[0].integrations) ?? [],
          visibility: rows[0].visibility,
          friendSync: rows[0].friendSync,
        };
      } else {
        return null;
      }
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  updateConnectedAccount: async (
    connection_id,
    visibility,
    friendSync = true,
    integrations = [],
    revoked = false,
  ) => {
    try {
      await database.runQuery(
        `UPDATE connected_accounts SET visibility = $1, friendSync = $2, integrations = $3, revoked = $4 WHERE account_id = $5`,
        [visibility, friendSync, JSON.stringify(integrations), revoked, connection_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  removeConnectedAccount: async (connection_id) => {
    try {
      await database.runQuery(`DELETE FROM connected_accounts WHERE account_id = $1`, [
        connection_id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  addConnectedAccount: async (user_id, platform, id, username) => {
    try {
      const date = new Date().toISOString();

      await database.runQuery(
        `INSERT INTO connected_accounts (user_id, account_id, username, connected_at, platform) VALUES ($1, $2, $3, $4, $5)`,
        [user_id, id, username, date, platform],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getRelationshipsByUserId: async (user_id) => {
    try {
      const rows = await database.runQuery(
        `
	            WITH r AS (
		            SELECT
		                user_id_1,
                        type,
                        user_id_2,
		                CASE user_id_1
		                    WHEN $1 THEN user_id_2
		                    ELSE user_id_1
		                END AS id
		            FROM relationships WHERE $1 = user_id_1 OR $1 = user_id_2
		        )
                SELECT * FROM users
                JOIN r ON users.id = r.id`,
        [user_id],
      );

      if (rows === null || rows.length === 0) {
        return [];
      }

      const ret = [];

      for (var relationship of rows) {
        if (relationship.user_id_1 === user_id && relationship.type === 3) {
          relationship.type = 4;
        }
        if (!(relationship.type === 2 && relationship.user_id_1 != user_id)) {
          //another user blocked this user, this user does not need to know that.
          ret.push({
            id: relationship.id,
            type: relationship.type,
            user: miniUserObject(relationship),
          });
        }
      }
      return ret;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  },
  modifyRelationship: async (user_id, relationship) => {
    try {
      if (relationship.type === 0) {
        await database.runQuery(
          `DELETE FROM relationships WHERE (user_id_1 = $1 AND user_id_2 = $2) OR (user_id_2 = $1 AND user_id_1 = $2)`,
          [user_id, relationship.id],
        );
      } else {
        await database.runQuery(
          `UPDATE relationships SET type = $1 WHERE user_id_1 = $2 OR user_id_2 = $2`,
          [relationship.type, user_id],
        );
      }
      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  addRelationship: async (initiator_id, type, target_id) => {
    try {
      await database.runQuery(
        'INSERT INTO relationships (user_id_1, type, user_id_2) VALUES ($1, $2, $3)',
        [initiator_id, type, target_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getGuildBans: async (id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT * FROM bans WHERE guild_id = $1
            `,
        [id],
      );

      if (rows != null && rows.length > 0) {
        const ret = [];

        for (var row of rows) {
          const user = await database.getAccountByUserId(row.user_id);

          if (user != null) {
            ret.push({
              user: miniUserObject(user),
            });
          }
        }

        return ret;
      } else {
        return [];
      }
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  }, //rewrite asap
  addMessageReaction: async (message, user_id, emoji_id, emoji_name) => {
    try {
      let reactions = message.reactions;

      if (
        reactions.find(
          (x) => x.user_id == user_id && x.emoji.id == emoji_id && x.emoji.name == emoji_name,
        )
      ) {
        reactions = reactions.filter(
          (x) => !(x.user_id == user_id && x.emoji.id === emoji_id && x.emoji.name === emoji_name),
        );
      }

      reactions.push({
        user_id: user_id,
        emoji: {
          id: emoji_id,
          name: emoji_name,
        },
      });

      await database.runQuery(`UPDATE messages SET reactions = $1 WHERE message_id = $2`, [
        JSON.stringify(reactions),
        message.id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  removeMessageReaction: async (message, user_id, emoji_id, emoji_name) => {
    try {
      let reactions = message.reactions;

      reactions = reactions.filter(
        (x) => !(x.user_id == user_id && x.emoji.id === emoji_id && x.emoji.name === emoji_name),
      );

      await database.runQuery(`UPDATE messages SET reactions = $1 WHERE message_id = $2`, [
        JSON.stringify(reactions),
        message.id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  createChannel: async (
    guild_id,
    name,
    type,
    position,
    recipients = [],
    owner_id = null,
    parent_id = null,
  ) => {
    try {
      const channel_id = generate();

      if (type === 1 || type === 3) {
        //create dm channel / group dm

        //Convert recipients to user snowflakes, discard other data
        const recipientIDs = usersToIDs(recipients);

        await database.runQuery(
          `INSERT INTO channels (id, type, guild_id, topic, last_message_id, permission_overwrites, name, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [channel_id, type, null, null, '0', null, null, 0],
        );

        //Convert recipient snowflakes to users
        const recipientUsers = [];

        for (let i = 0; i < recipients.length; i++) {
          if (!recipients) continue;

          let user;

          if (typeof recipients[i] === 'string') {
            user = await database.getAccountByUserId(recipients[i]);

            if (!user) continue;

            user = miniUserObject(user);
          } else {
            user = recipients[i];
          }

          if (user) recipientUsers.push(user);
        }

        if (type === 1) {
          //DM channel
          await database.runQuery(
            `INSERT INTO dm_channels (id, user1, user2) VALUES ($1, $2, $3)`,
            [channel_id, recipientIDs[0], recipientIDs[1]],
          );

          return {
            id: channel_id,
            guild_id: null,
            type: type,
            last_message_id: '0',
            recipients: recipientUsers ?? [],
          };
        } else if (type === 3) {
          //Group channel
          await database.runQuery(
            `INSERT INTO group_channels (id, icon, name, owner_id, recipients) VALUES ($1, $2, $3, $4, $5)`,
            [channel_id, null, '', owner_id, JSON.stringify(recipientIDs)],
          );

          return {
            id: channel_id,
            guild_id: null,
            type: type,
            last_message_id: '0',
            recipients: recipientUsers ?? [],
            name: '',
            icon: null,
            owner_id: owner_id,
          };
        }
      }

      await database.runQuery(
        `INSERT INTO channels (id, type, parent_id, guild_id, topic, last_message_id, permission_overwrites, name, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [channel_id, type, parent_id, guild_id, null, '0', null, name, 0],
      );

      return {
        id: channel_id,
        name: name,
        ...((parseInt(type) === 0 ||
          parseInt(type) === 2 ||
          parseInt(type) === 5 ||
          parseInt(type) === 4) && {
          guild_id: guild_id,
        }), //do this better
        ...((parseInt(type) === 0 || parseInt(type) === 2 || parseInt(type) === 5) && {
          parent_id: parent_id,
        }),
        type: parseInt(type),
        ...(parseInt(type) === 0 && {
          topic: null,
          rate_limit_per_user: 0,
          nsfw: false,
          last_message_id: '0',
        }),
        ...(parseInt(type) === 2 && {
          bitrate: 64000,
          user_limit: 0,
        }),
        permission_overwrites: [],
        position: position,
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  }, //rewrite asap
  updateGuildMemberNick: async (guild_id, member_id, new_nick) => {
    try {
      const nick =
        new_nick == null || new_nick.length > config.limits['nickname'].max ? null : new_nick;

      await database.runQuery(`UPDATE members SET nick = $1 WHERE guild_id = $2 AND user_id = $3`, [
        nick,
        guild_id,
        member_id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  updateChannel: async (channel_id, channel, groupOwnerPassOver = false) => {
    try {
      const type = parseInt(channel.type);

      //text, voice, category, news
      if ([0, 2, 4, 5].includes(type)) {
        const queryFields = [
          'name = $1',
          'parent_id = $2',
          'position = $3',
          'permission_overwrites = $4',
        ];
        const params = [
          channel.name,
          channel.parent_id,
          channel.position,
          channel.permission_overwrites
            ? SerializeOverwritesToString(channel.permission_overwrites)
            : null,
        ];

        if (type === 0) {
          // text
          queryFields.push(
            'topic = $5',
            'nsfw = $6',
            'last_message_id = $7',
            'rate_limit_per_user = $8',
          );
          params.push(
            channel.topic,
            channel.nsfw ? 1 : 0,
            channel.last_message_id,
            channel.rate_limit_per_user,
          );
        } else if (type === 2) {
          // voice
          queryFields.push('bitrate = $5', 'user_limit = $6');
          params.push(channel.bitrate, channel.user_limit);
        }

        const query = `UPDATE channels SET ${queryFields.join(', ')} WHERE id = $${params.length + 1}`;

        params.push(channel_id);

        await database.runQuery(query, params);

        return channel;
      }

      //group dms
      if (type === 3) {
        if (channel.icon && channel.icon.includes('data:image/')) {
          const extension = channel.icon.split('/')[1].split(';')[0].replace('jpeg', 'jpg');
          const imgData = channel.icon.replace(/^data:image\/\w+;base64,/, '');
          const iconHash = md5(generateString(30));

          const dir = `./www_dynamic/group_icons/${channel_id}`;

          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }

          writeFileSync(`${dir}/${iconHash}.${extension}`, imgData, 'base64');

          channel.icon = iconHash;

          await database.runQuery(`UPDATE group_channels SET icon = $1 WHERE id = $2`, [
            iconHash,
            channel_id,
          ]);
        } else if (channel.icon === null) {
          await database.runQuery(`UPDATE group_channels SET icon = $1 WHERE id = $2`, [
            null,
            channel_id,
          ]);
        }

        const groupFields = ['name = $1'];
        const groupParams = [channel.name ?? ''];

        if (groupOwnerPassOver) {
          groupFields.push('owner_id = $2');
          groupParams.push(channel.owner_id);
        }

        const query = `UPDATE group_channels SET ${groupFields.join(', ')} WHERE id = $${groupParams.length + 1}`;

        groupParams.push(channel_id);

        await database.runQuery(query, groupParams);

        return channel;
      }

      return null;
    } catch (error) {
      logText(error, 'error');
      return null;
    }
  },
  updateChannelRecipients: async (channel_id, recipients) => {
    try {
      if (!recipients) return false;

      const recipientIDs = usersToIDs(recipients);

      await database.runQuery(`UPDATE group_channels SET recipients = $1 WHERE id = $2`, [
        JSON.stringify(recipientIDs),
        channel_id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getUsersMessagesInGuild: async (guild_id, author_id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT * FROM messages WHERE author_id = $1 AND guild_id = $2
            `,
        [author_id, guild_id],
      );

      if (rows == null || rows.length == 0) {
        return [];
      }

      const ret = [];

      for (var row of rows) {
        const message = await database.getMessageById(row.message_id);

        if (message != null) {
          ret.push(message);
        }
      }

      return ret;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  }, //rewrite asap - implement batch message fetching function
  getMessageById: async (id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT * FROM messages WHERE message_id = $1
            `,
        [id],
      );

      if (rows == null || rows.length == 0) {
        return null;
      }

      const isWebhook = rows[0].author_id.includes('WEBHOOK_');
      let author = null;

      if (isWebhook) {
        const parts = rows[0].author_id.split('_');
        const webhookId = parts[1];
        const overrideId = parts[2];
        const webhook = await database.getWebhookById(webhookId);

        if (!webhook) {
          author = {
            id: webhookId,
            username: 'Deleted Webhook',
            discriminator: '0000',
            avatar: null,
            bot: true,
            webhook: true,
          };
        } else {
          const override = await database.getWebhookOverrides(webhookId, overrideId);

          author = {
            username: override?.username || webhook.name,
            avatar: override?.avatar_url || webhook.avatar,
            discriminator: '0000',
            id: override?.id || webhookId,
            bot: true,
            webhook: true,
          };
        }
      } else {
        author = (await database.getAccountByUserId(rows[0].author_id)) || {
          id: '456226577798135808',
          username: 'Deleted User',
          discriminator: '0000',
          avatar: null,
          bot: false,
        };
      }

      const mentions_data = parseMentions(rows[0].content);

      const mentions = [];

      if (mentions_data.mentions && mentions_data.mentions.length > 0) {
        for (var mention_id of mentions_data.mentions) {
          const mention = await database.getAccountByUserId(mention_id);

          if (mention != null) {
            mentions.push(miniUserObject(mention));
          }
        }
      }

      const attachments = await database.runQuery(
        `
                SELECT * FROM attachments WHERE message_id = $1
            `,
        [id],
      );

      const messageAttachments = [];

      if (attachments != null && attachments.length > 0) {
        for (var attachment of attachments) {
          messageAttachments.push({
            filename: attachment.filename,
            height: attachment.height,
            width: attachment.width,
            id: attachment.attachment_id,
            proxy_url: attachment.url,
            url: attachment.url,
            size: attachment.size,
          });
        }
      }

      const reactionRet = [];
      const msgReactions = JSON.parse(rows[0].reactions);

      for (var row of msgReactions) {
        reactionRet.push({
          user_id: row.user_id,
          emoji: row.emoji,
        });
      }

      return formatMessage(
        rows[0],
        author,
        messageAttachments,
        mentions,
        mentions_data.mention_roles,
        reactionRet,
        isWebhook,
      );
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  }, //rewrite asap
  getPinnedMessagesInChannel: async (channel_id) => {
    try {
      const rows = await database.runQuery(
        `SELECT * FROM messages WHERE channel_id = $1 AND pinned = $2`,
        [channel_id, 1],
      );

      if (rows == null || rows.length == 0) {
        return [];
      }

      const ret = [];

      for (const row of rows) {
        const message = await database.getMessageById(row.message_id);

        if (message != null) {
          ret.push(message);
        }
      }

      return ret;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  }, //rewrite asap
  getBotByApplicationId: async (application_id) => {
    try {
      const rows = await database.runQuery(`SELECT * FROM bots WHERE application_id = $1`, [
        application_id,
      ]);

      if (rows == null || rows.length == 0) {
        return null;
      }

      return {
        avatar: rows[0].avatar,
        bot: true,
        discriminator: rows[0].discriminator,
        id: rows[0].id,
        public: rows[0].public,
        require_code_grant: rows[0].require_code_grant,
        token: rows[0].token,
        username: rows[0].username,
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  abracadabraApplication: async (application) => {
    try {
      const salt = await genSalt(10);
      const pwHash = await hash(generateString(30), salt);
      let discriminator = Math.round(Math.random() * 9999);

      while (discriminator < 1000) {
        discriminator = Math.round(Math.random() * 9999);
      }

      const token = generateToken(application.id, pwHash);

      await database.runQuery(
        `INSERT INTO bots (id, application_id, username, discriminator, avatar, token) VALUES ($1, $2, $3, $4, $5, $6)`,
        [application.id, application.id, application.name, discriminator.toString(), null, token],
      );

      return {
        avatar: null,
        bot: true,
        discriminator: discriminator.toString(),
        id: application.id,
        public: true,
        require_code_grant: false,
        token: token,
        username: application.name,
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  updateBotUser: async (bot) => {
    try {
      let send_icon = bot.avatar;

      if (bot.avatar != null) {
        if (bot.avatar.includes('data:image')) {
          var extension = bot.avatar.split('/')[1].split(';')[0];
          var imgData = bot.avatar.replace(`data:image/${extension};base64,`, '');
          var file_name = generateString(30);
          var hash = md5(file_name);

          if (extension == 'jpeg') {
            extension = 'jpg';
          }

          send_icon = hash.toString();

          if (!existsSync(`www_dynamic/avatars`)) {
            mkdirSync(`www_dynamic/avatars`, { recursive: true });
          }

          if (!existsSync(`www_dynamic/avatars/${bot.id}`)) {
            mkdirSync(`www_dynamic/avatars/${bot.id}`, { recursive: true });

            writeFileSync(`www_dynamic/avatars/${bot.id}/${hash}.${extension}`, imgData, 'base64');
          } else {
            writeFileSync(`www_dynamic/avatars/${bot.id}/${hash}.${extension}`, imgData, 'base64');
          }
        } else {
          send_icon = bot.avatar;
        }
      }

      await database.runQuery(`UPDATE bots SET avatar = $1, username = $2 WHERE id = $3`, [
        send_icon,
        bot.username,
        bot.id,
      ]);

      bot.avatar = send_icon;

      return bot;
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  updateBot: async (bot) => {
    try {
      let send_icon = null;

      if (bot.avatar != null) {
        if (bot.avatar.includes('data:image')) {
          var extension = bot.avatar.split('/')[1].split(';')[0];
          var imgData = bot.avatar.replace(`data:image/${extension};base64,`, '');
          var file_name = generateString(30);
          var hash = md5(file_name);

          if (extension == 'jpeg') {
            extension = 'jpg';
          }

          send_icon = hash.toString();

          if (!existsSync(`www_dynamic/avatars`)) {
            mkdirSync(`www_dynamic/avatars`, { recursive: true });
          }

          if (!existsSync(`www_dynamic/avatars/${bot.id}`)) {
            mkdirSync(`www_dynamic/avatars/${bot.id}`, { recursive: true });

            writeFileSync(`www_dynamic/avatars/${bot.id}/${hash}.${extension}`, imgData, 'base64');
          } else {
            writeFileSync(`www_dynamic/avatars/${bot.id}/${hash}.${extension}`, imgData, 'base64');
          }
        } else {
          send_icon = bot.avatar;
        }
      }

      await database.runQuery(
        `UPDATE bots SET avatar = $1, username = $2, public = $3, require_code_grant = $4 WHERE id = $5`,
        [send_icon, bot.username, bot.public, bot.require_code_grant, bot.id],
      );

      bot.avatar = send_icon;

      return bot;
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  updateUserApplication: async (application) => {
    try {
      let send_icon = null;

      if (application.icon != null) {
        if (application.icon.includes('data:image')) {
          var extension = application.icon.split('/')[1].split(';')[0];
          var imgData = application.icon.replace(`data:image/${extension};base64,`, '');
          var file_name = generateString(30);
          var hash = md5(file_name);

          if (extension == 'jpeg') {
            extension = 'jpg';
          }

          send_icon = hash.toString();

          if (!existsSync(`www_dynamic/applications_icons`)) {
            mkdirSync(`www_dynamic/applications_icons`, { recursive: true });
          }

          if (!existsSync(`www_dynamic/applications_icons/${application.id}`)) {
            mkdirSync(`www_dynamic/applications_icons/${application.id}`, { recursive: true });

            writeFileSync(
              `www_dynamic/applications_icons/${application.id}/${hash}.${extension}`,
              imgData,
              'base64',
            );
          } else {
            writeFileSync(
              `www_dynamic/applications_icons/${application.id}/${hash}.${extension}`,
              imgData,
              'base64',
            );
          }
        } else {
          send_icon = application.icon;
        }
      }

      await database.runQuery(
        `UPDATE applications SET icon = $1, name = $2, description = $3 WHERE id = $4`,
        [send_icon, application.name, application.description, application.id],
      );

      application.icon = send_icon;

      return application;
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  createUserApplication: async (user, name) => {
    try {
      const id = generate();
      const secret = generateString(20);

      await database.runQuery(
        `INSERT INTO applications (id, owner_id, name, icon, secret, description) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, user.id, name, null, secret, ''],
      );

      return {
        id: id,
        name: name,
        icon: null,
        description: '',
        redirect_uris: [],
        rpc_application_state: 0,
        rpc_origins: [],
        secret: secret,
        owner: miniUserObject(user),
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getApplicationById: async (application_id) => {
    try {
      const rows = await database.runQuery(`SELECT * FROM applications WHERE id = $1`, [
        application_id,
      ]);

      if (rows == null || rows.length == 0) {
        return null;
      }

      const owner = await database.getAccountByUserId(rows[0].owner_id);

      if (!owner) return null;

      return {
        id: rows[0].id,
        name: rows[0].name == null ? 'My Application' : rows[0].name,
        icon: rows[0].icon,
        description: rows[0].description == null ? '' : rows[0].description,
        redirect_uris: [],
        rpc_application_state: 0,
        rpc_origins: [],
        secret: rows[0].secret,
        owner: miniUserObject(owner),
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  }, //rewrite asap
  deleteBotById: async (id) => {
    try {
      await Promise.all([
        database.runQuery(`DELETE FROM applications WHERE id = $1`, [id]),
        database.runQuery(`DELETE FROM bots WHERE id = $1`, [id]),
        //database.runQuery(`DELETE FROM messages WHERE author_id = $1`, [id]),
      ]);
    } catch (error) {
      return false;
    }
  },
  getUsersApplications: async (user) => {
    try {
      const rows = await database.runQuery(`SELECT * FROM applications WHERE owner_id = $1`, [
        user.id,
      ]);

      if (rows == null || rows.length == 0) {
        return [];
      }

      const ret = [];

      for (const row of rows) {
        ret.push({
          id: row.id,
          name: row.name == null ? 'My Application' : row.name,
          icon: row.icon,
          description: row.description == null ? '' : row.description,
          redirect_uris: [],
          rpc_application_state: 0,
          rpc_origins: [],
          secret: row.secret,
          owner: miniUserObject(user),
        });
      }

      return ret;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  },
  getUsersBots: async (user) => {
    try {
      const rows = await database.runQuery(
        `SELECT a.*, b.id AS bot_id, b.username AS bot_username, b.discriminator AS bot_discriminator, b.avatar AS bot_avatar, b.public, b.require_code_grant, o.username AS owner_username,  o.discriminator AS owner_discriminator,  o.id AS owner_id,  o.avatar AS owner_avatar,  o.flags AS owner_flags FROM applications AS a JOIN bots AS b ON a.id = b.application_id JOIN users AS o ON a.owner_id = o.id WHERE a.owner_id = $1`,
        [user.id],
      );

      if (rows == null || rows.length == 0) {
        return [];
      }

      const ret = [];

      for (const row of rows) {
        ret.push({
          avatar: row.bot_avatar,
          discriminator: row.bot_discriminator,
          username: row.bot_username,
          id: row.bot_id,
          public: row.public,
          require_code_grant: row.require_code_grant,
          application: {
            id: row.id,
            name: row.name,
            icon: row.icon,
            description: row.description,
            redirect_uris: [],
            rpc_application_state: 0,
            rpc_origins: [],
            owner: {
              username: row.owner_username,
              discriminator: row.owner_discriminator,
              id: row.owner_id,
              avatar: row.owner_avatar,
              bot: false,
              flags: row.owner_flags,
              premium: true,
            },
          },
        });
      }

      return ret;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  },
  //to-do add role mention support
  getRecentMentions: async (
    user_id,
    before_id,
    limit,
    include_roles,
    include_everyone_mentions,
    guild_id,
  ) => {
    try {
      let query = `
            SELECT m.* FROM messages AS m 
            WHERE 
        `;
      const params = [];
      let paramIndex = 1;

      if (guild_id) {
        query += `m.guild_id = $${paramIndex++} AND `;
        params.push(guild_id);
      }

      if (before_id) {
        query += `m.message_id < $${paramIndex++} AND `;
        params.push(before_id);
      }

      const mentionConditions = [];

      mentionConditions.push(`m.content LIKE '%<@${user_id}>%'`);

      if (include_everyone_mentions) {
        mentionConditions.push(`m.mention_everyone = TRUE`);
      }

      query += `(${mentionConditions.join(' OR ')}) `;

      query += `ORDER BY m.message_id DESC LIMIT $${paramIndex}`;
      params.push(limit);

      const messageRows = await database.runQuery(query, params);

      if (!messageRows || messageRows.length === 0) {
        return [];
      }

      const messageIds = messageRows.map((row) => row.message_id);
      const uniqueUserIds = new Set();

      for (const row of messageRows) {
        uniqueUserIds.add(row.author_id);
        const mentions_data = parseMentions(row.content);
        if (mentions_data.mentions && mentions_data.mentions.length > 0) {
          mentions_data.mentions.forEach((uid) => uniqueUserIds.add(uid));
        }
      }

      const userIdArray = Array.from(uniqueUserIds).filter((id) => !id.startsWith('WEBHOOK_'));

      const accounts = await database.getAccountsByIds(userIdArray);
      const accountMap = new Map(accounts.map((acc) => [acc.id, acc]));

      const attachmentsRows = await database.runQuery(
        `
            SELECT * FROM attachments WHERE message_id = ANY($1)
        `,
        [messageIds],
      );

      const attachmentsMap = new Map();

      if (attachmentsRows) {
        for (const attachment of attachmentsRows) {
          if (!attachmentsMap.has(attachment.message_id)) {
            attachmentsMap.set(attachment.message_id, []);
          }

          attachmentsMap.get(attachment.message_id).push({
            filename: attachment.filename,
            height: attachment.height,
            width: attachment.width,
            id: attachment.attachment_id,
            proxy_url: attachment.url,
            url: attachment.url,
            size: attachment.size,
          });
        }
      }

      const finalMessages = [];

      for (const row of messageRows) {
        let author = null;
        const isWebhook = row.author_id.includes('WEBHOOK_');

        if (isWebhook) {
          const parts = row.author_id.split('_');
          const webhookId = parts[1];
          const overrideId = parts[2];
          const webhook = await database.getWebhookById(webhookId);
          const webhookOverride = await database.getWebhookOverrides(webhookId, overrideId);

          if (webhook) {
            author = {
              id: webhookId,
              username: webhookOverride?.username || webhook.name,
              avatar: webhookOverride?.avatar_url || webhook.avatar,
              bot: true,
              webhook: true,
              flags: 0,
              discriminator: '0000',
            };
          } else {
            author = {
              id: webhookId,
              username: 'Deleted Webhook',
              discriminator: '0000',
              avatar: null,
              bot: true,
              webhook: true,
            };
          }
        } else {
          author = accountMap.get(row.author_id) || {
            id: '456226577798135808',
            username: 'Deleted User',
            discriminator: '0000',
            avatar: null,
            bot: false,
          };
        }

        const mentions_data = parseMentions(row.content);
        const mentions = [];

        if (mentions_data.mentions && mentions_data.mentions.length > 0) {
          for (const mention_id of mentions_data.mentions) {
            const mention = accountMap.get(mention_id);

            if (mention) {
              mentions.push(mention);
            }
          }
        }

        const messageAttachments = attachmentsMap.get(row.message_id) || [];

        finalMessages.push(
          formatMessage(
            row,
            author,
            messageAttachments,
            mentions,
            mentions_data.mention_roles,
            [],
            isWebhook,
          ),
        );
      }

      return finalMessages;
    } catch (error) {
      logText(error, 'error');
      return [];
    }
  },
  getMessageByCdnLink: async (cdn_link) => {
    try {
      const rows = await database.runQuery(`SELECT message_id FROM attachments WHERE url = $1`, [
        cdn_link,
      ]);

      if (rows == null || rows.length == 0) {
        return null;
      }

      const message = await database.getMessageById(rows[0].message_id);

      return message; //to-do clean this up
    } catch (error) {
      logText(error, 'error');
      return null;
    }
  },
  getChannelMessages: async (id, requester_id, limit, before_id, after_id, includeReactions) => {
    try {
      let query = `SELECT * FROM messages WHERE channel_id = $1 `;
      const params = [id];
      let paramIndex = 2;
      let needsReverse = false;

      if (before_id && after_id) {
        query += `AND message_id < $${paramIndex++} AND message_id > $${paramIndex++} ORDER BY message_id DESC LIMIT $${paramIndex}`;
        params.push(before_id, after_id, limit);
      } else if (before_id) {
        query += `AND message_id < $${paramIndex++} ORDER BY message_id DESC LIMIT $${paramIndex}`;
        params.push(before_id, limit);
      } else if (after_id) {
        query += `AND message_id > $${paramIndex++} ORDER BY message_id ASC LIMIT $${paramIndex}`;
        params.push(after_id, limit);
        needsReverse = true;
      } else {
        query += `ORDER BY message_id DESC LIMIT $${paramIndex}`;
        params.push(limit);
      }

      const messageRows = await database.runQuery(query, params);

      if (messageRows === null || messageRows.length === 0) {
        return [];
      }

      if (needsReverse) {
        messageRows.reverse();
      }

      const messageIds = messageRows.map((row) => row.message_id);
      const uniqueUserIds = new Set();

      for (const row of messageRows) {
        uniqueUserIds.add(row.author_id);

        const mentions_data = parseMentions(row.content);

        if (mentions_data.mentions && mentions_data.mentions.length > 0) {
          mentions_data.mentions.forEach((uid) => uniqueUserIds.add(uid));
        }
      }

      const userIdArray = Array.from(uniqueUserIds);

      const accounts = await database.getAccountsByIds(userIdArray);

      const accountMap = new Map();

      if (accounts && accounts.length > 0) {
        accounts.forEach((acc) => accountMap.set(acc.id, acc));
      }

      const attachmentsRows = await database.runQuery(
        `
                SELECT * FROM attachments WHERE message_id = ANY($1)
            `,
        [messageIds],
      );

      const attachmentsMap = new Map();

      if (attachmentsRows) {
        for (const attachment of attachmentsRows) {
          if (!attachmentsMap.has(attachment.message_id)) {
            attachmentsMap.set(attachment.message_id, []);
          }

          attachmentsMap.get(attachment.message_id).push({
            filename: attachment.filename,
            height: attachment.height,
            width: attachment.width,
            id: attachment.attachment_id,
            proxy_url: attachment.url,
            url: attachment.url,
            size: attachment.size,
          });
        }
      }

      const finalMessages = [];

      for (const row of messageRows) {
        const isWebhook = row.author_id.includes('WEBHOOK_');
        let author = null;

        if (isWebhook) {
          const webhookId = row.author_id.split('_')[1];
          const overrideId = row.author_id.split('_')[2];
          const webhook = await database.getWebhookById(webhookId);
          const webhookOverride = await database.getWebhookOverrides(webhookId, overrideId);

          if (webhook) {
            author = {
              id: webhookId,
              username: webhookOverride?.username || webhook.name,
              avatar: webhookOverride?.avatar_url || webhook.avatar,
              bot: true,
              webhook: true,
              flags: 0,
              discriminator: '0000',
            };
          } else {
            author = {
              id: webhookId,
              username: 'Deleted Webhook',
              discriminator: '0000',
              avatar: null,
              bot: true,
              webhook: true,
            }; //Should we check for this?
          }
        } else {
          author = accountMap.get(row.author_id) || {
            id: '456226577798135808',
            username: 'Deleted User',
            discriminator: '0000',
            bot: false,
          };
        }

        const mentions_data = parseMentions(row.content);
        const mentions = [];

        if (mentions_data.mentions && mentions_data.mentions.length > 0) {
          for (const mention_id of mentions_data.mentions) {
            const mention = accountMap.get(mention_id);
            if (mention) {
              mentions.push(mention);
            }
          }
        }

        const messageAttachments = attachmentsMap.get(row.message_id) || [];
        const msgReactions = JSON.parse(row.reactions) || [];

        const rawReactions = [];

        for (const reactionRow of msgReactions) {
          const reactionKey = JSON.stringify(reactionRow.emoji);

          if (
            !rawReactions.find(
              (x) => x.user_id === reactionRow.user_id && JSON.stringify(x.emoji) === reactionKey,
            )
          ) {
            rawReactions.push({
              user_id: reactionRow.user_id,
              emoji: reactionRow.emoji,
            });
          }
        }

        let finalReactions = rawReactions;

        if (includeReactions && rawReactions.length > 0) {
          const reactionMap = rawReactions.reduce((acc, reaction) => {
            const key = JSON.stringify(reaction.emoji);

            if (!acc[key]) {
              acc[key] = {
                emoji: reaction.emoji,
                count: 0,
                me: false,
              };
            }

            acc[key].count++;

            if (reaction.user_id === requester_id) {
              acc[key].me = true;
            }

            return acc;
          }, {});

          finalReactions = Object.values(reactionMap);
        }

        finalMessages.push(
          formatMessage(
            row,
            author,
            messageAttachments,
            mentions,
            mentions_data.mention_roles,
            finalReactions,
            isWebhook,
          ),
        );
      }

      return finalMessages;
    } catch (error) {
      logText(error, 'error');
      return [];
    }
  },
  getAccountsByIds: async (ids) => {
    try {
      if (!ids || ids.length === 0) {
        return [];
      }

      const accounts = [];
      const humans = new Set();
      const robots = new Set();
      const humanIds = ids.filter((id) => !id.startsWith('WEBHOOK_'));
      const rawWebhookIds = ids.filter((id) => id.startsWith('WEBHOOK_'));

      let bots = [];

      if (humanIds.length > 0) {
        const rows =
          (await database.runQuery(
            `SELECT id, username, discriminator, avatar, flags FROM users WHERE id = ANY($1::text[])`,
            [humanIds],
          )) ?? [];

        const foundHumanIds = new Set(rows.map((row) => row.id));

        bots = humanIds.filter((id) => !foundHumanIds.has(id));

        for (const row of rows) {
          humans.add(row.id);

          accounts.push({
            username: row.username,
            discriminator: row.discriminator,
            id: row.id,
            avatar: row.avatar,
            bot: false,
            flags: row.flags,
            premium: true,
          });
        }
      } else bots = [...ids];

      let webhooksToFetch = rawWebhookIds;

      if (bots.length > 0) {
        const botOnlyIds = bots.filter((id) => !id.startsWith('WEBHOOK_'));

        const botRows =
          (await database.runQuery(
            `SELECT id, username, discriminator, avatar FROM bots WHERE id = ANY($1::text[])`,
            [botOnlyIds],
          )) ?? [];

        const foundBotIds = new Set(botRows.map((row) => row.id));

        webhooksToFetch = webhooksToFetch.concat(bots.filter((id) => !foundBotIds.has(id)));

        for (const row of botRows) {
          robots.add(row.id);

          accounts.push({
            username: row.username,
            discriminator: row.discriminator,
            id: row.id,
            avatar: row.avatar,
            bot: true,
            flags: 0,
            premium: true,
          });
        }
      }

      if (webhooksToFetch.length > 0) {
        const uniqueWebhookIds = new Set();
        const webhookOverrideIds = [];

        for (const id of webhooksToFetch) {
          if (id.startsWith('WEBHOOK_')) {
            const parts = id.split('_');
            const webhookId = parts[1];
            const overrideId = parts[2];

            uniqueWebhookIds.add(webhookId);
            webhookOverrideIds.push({ rawId: id, webhookId, overrideId });
          }
        }

        const baseWebhooks =
          (await database.runQuery(
            `
                    SELECT id, name, avatar FROM webhooks WHERE id = ANY($1::text[])
                `,
            [[...uniqueWebhookIds]],
          )) ?? [];

        const webhookDataMap = new Map(baseWebhooks.map((w) => [w.id, w]));

        const overrideIdPairs = webhookOverrideIds
          .filter((item) => item.overrideId !== null)
          .map((item) => [item.webhookId, item.overrideId]);

        let overridesMap = new Map();

        if (overrideIdPairs.length > 0) {
          const allOverrides =
            (await database.runQuery(
              `
                        SELECT id, override_id, avatar_url, username 
                        FROM webhook_overrides 
                        WHERE id = ANY($1::text[])
                    `,
              [[...uniqueWebhookIds]],
            )) ?? [];

          overridesMap = new Map(allOverrides.map((o) => [`${o.id}_${o.override_id}`, o]));
        }

        for (const item of webhookOverrideIds) {
          const baseWebhook = webhookDataMap.get(item.webhookId);

          if (!baseWebhook) {
            continue;
          }

          const overrideKey = `${item.webhookId}_${item.overrideId}`;
          const override = overridesMap.get(overrideKey);

          if (override) {
            accounts.push({
              username: override.username === null ? baseWebhook.name : override.username,
              discriminator: '0000',
              avatar: override.avatar_url,
              id: override.id,
              bot: true,
              webhook: true,
            });
          } else {
            accounts.push({
              username: baseWebhook.name,
              discriminator: '0000',
              id: baseWebhook.id,
              bot: true,
              webhook: true,
              avatar: baseWebhook.avatar,
            });
          }
        }
        //We really need a better way to handle webhooks huh..
      }

      return accounts;
    } catch (error) {
      logText(error, 'error');
      return [];
    }
  },
  getMessagesAround: async (channel_id, message_id, limit = 50) => {
    try {
      const actualLimit = Math.floor(limit / 2);
      const messageRows = await database.runQuery(
        `
                SELECT * FROM (
                    (SELECT * FROM messages WHERE channel_id = $1 AND message_id <= $2 ORDER BY message_id DESC LIMIT $3)
                    UNION ALL
                    (SELECT * FROM messages WHERE channel_id = $1 AND message_id > $2 ORDER BY message_id ASC LIMIT $4)
                ) AS combined_messages
                ORDER BY message_id DESC`,
        [channel_id, message_id, actualLimit + 1, actualLimit],
      ); //So select all messages before the around id descending limited by half the sandwich limit, then add it on with the other query to select where its above the 2nd id ascending, then sort the final msgs by ascending order (oldest -> newest)

      if (messageRows.length === 0) {
        return [];
      }

      const messageIds = messageRows.map((row) => row.message_id);
      const uniqueUserIds = new Set();

      messageRows.forEach((row) => {
        uniqueUserIds.add(
          row.author_id.includes('WEBHOOK_') ? row.author_id.split('_')[1] : row.author_id,
        );
        const mentionsData = parseMentions(row.content);
        mentionsData.mentions?.forEach((id) => uniqueUserIds.add(id));
      });

      const [accounts, attachmentsRows] = await Promise.all([
        database.getAccountsByIds(Array.from(uniqueUserIds)),
        database.runQuery(`SELECT * FROM attachments WHERE message_id = ANY($1)`, [messageIds]),
      ]);

      const accountMap = new Map(accounts.map((acc) => [acc.id, acc]));
      const attachmentsMap = new Map();

      attachmentsRows?.forEach((att) => {
        if (!attachmentsMap.has(att.message_id)) {
          attachmentsMap.set(att.message_id, []);
        }

        attachmentsMap.get(att.message_id).push({
          filename: att.filename,
          height: att.height,
          width: att.width,
          id: att.attachment_id,
          proxy_url: att.url,
          url: att.url,
          size: att.size,
        });
      });

      return await Promise.all(
        messageRows.map(async (row) => {
          const isWebhook = row.author_id.includes('WEBHOOK_');
          let author = null;

          if (isWebhook) {
            const webhookId = row.author_id.split('_')[1];
            const overrideId = row.author_id.split('_')[2];
            const webhook = await database.getWebhookById(webhookId);
            const webhookOverride = await database.getWebhookOverrides(webhookId, overrideId);

            if (webhook) {
              author = {
                id: webhookId,
                username: webhookOverride?.username || webhook.name,
                avatar: webhookOverride?.avatar_url || webhook.avatar,
                bot: true,
                webhook: true,
                flags: 0,
                discriminator: '0000',
              };
            } else {
              author = {
                id: webhookId,
                username: 'Deleted Webhook',
                discriminator: '0000',
                avatar: null,
                bot: true,
                webhook: true,
              }; //Should we check for this?
            }
          } else {
            author = accountMap.get(row.author_id) || {
              id: '456226577798135808',
              username: 'Deleted User',
              discriminator: '0000',
              bot: false,
            };
          }

          const mentionsData = parseMentions(row.content);
          const mentions = (mentionsData.mentions || [])
            .map((id) => accountMap.get(id))
            .filter(Boolean);

          return formatMessage(
            row,
            author,
            attachmentsMap.get(row.message_id) || [],
            mentions,
            mentionsData.mention_roles || [],
            [],
            isWebhook,
          );
        }),
      );
    } catch (error) {
      logText(error, 'error');
      return [];
    }
  }, //to-do move the hydration of author, etc objects to its own function PLEASE.
  getGuildMessages: async (
    guild_id,
    author_id,
    containsContent,
    channel_id,
    mentions_user_id,
    includeNsfw,
    before_id,
    after_id,
    limit,
    offset,
  ) => {
    try {
      const whereClause = ` WHERE m.guild_id = $1 `;
      const params = [guild_id];
      const paramIndex = 2;

      const buildWhere = (pIndex) => {
        let clause = '';
        const p = [...params];

        if (author_id) {
          clause += ` AND m.author_id = $${pIndex++}`;
          p.push(author_id);
        }

        if (containsContent) {
          clause += ` AND LOWER(m.content) LIKE LOWER($${pIndex++})`;
          p.push(`%${containsContent}%`);
        }

        if (channel_id) {
          clause += ` AND m.channel_id = $${pIndex++}`;
          p.push(channel_id);
        }

        if (mentions_user_id) {
          clause += ` AND m.content LIKE $${pIndex++}`;
          p.push(`%<@${mentions_user_id}>%`);
        }

        if (before_id) {
          clause += ` AND m.message_id < $${pIndex++}`;
          p.push(before_id);
        }

        if (after_id) {
          clause += ` AND m.message_id > $${pIndex++}`;
          p.push(after_id);
        }

        if (!includeNsfw) {
          clause += ` AND ch.nsfw = FALSE`;
        }

        return { clause, params: p, nextIndex: pIndex };
      };

      const { clause, params: mainParams, nextIndex: finalIndex } = buildWhere(paramIndex);

      const countQuery = `SELECT COUNT(m.message_id) AS total_count FROM messages AS m INNER JOIN channels AS ch ON m.channel_id = ch.id ${whereClause} ${clause}`;

      const countRows = await database.runQuery(countQuery, mainParams);
      const totalCount = parseInt(countRows[0].total_count) || 0;

      if (totalCount === 0) {
        return { messages: [], totalCount: 0 };
      }

      const dataQuery = `SELECT m.* FROM messages AS m INNER JOIN channels AS ch ON m.channel_id = ch.id ${whereClause} ${clause} ORDER BY m.message_id DESC LIMIT $${finalIndex} OFFSET $${finalIndex + 1}`;

      mainParams.push(parseInt(limit), parseInt(offset));

      const messageRows = await database.runQuery(dataQuery, mainParams);

      if (messageRows.length === 0) {
        return { messages: [], totalCount };
      }

      const messageIds = messageRows.map((row) => row.message_id);
      const uniqueUserIds = new Set();

      for (const row of messageRows) {
        uniqueUserIds.add(row.author_id);

        const mentions_data = parseMentions(row.content);

        if (mentions_data.mentions && mentions_data.mentions.length > 0) {
          mentions_data.mentions.forEach((id) => uniqueUserIds.add(id));
        }
      }

      const userIdArray = Array.from(uniqueUserIds);

      const accounts = await database.getAccountsByIds(userIdArray);
      const accountMap = new Map();

      if (accounts && accounts.length > 0) {
        accounts.forEach((acc) => accountMap.set(acc.id, acc));
      }

      const attachmentsRows = await database.runQuery(
        `
                SELECT * FROM attachments WHERE message_id = ANY($1)
            `,
        [messageIds],
      );

      const attachmentsMap = new Map();

      if (attachmentsRows) {
        for (const attachment of attachmentsRows) {
          if (!attachmentsMap.has(attachment.message_id)) {
            attachmentsMap.set(attachment.message_id, []);
          }

          attachmentsMap.get(attachment.message_id).push({
            filename: attachment.filename,
            height: attachment.height,
            width: attachment.width,
            id: attachment.attachment_id,
            proxy_url: attachment.url,
            url: attachment.url,
            size: attachment.size,
          });
        }
      }

      const messages = [];

      for (const row of messageRows) {
        let webhookRawId = null;
        let isWebhook = false;

        if (row.author_id.includes('WEBHOOK_')) {
          webhookRawId = row.author_id;

          row.author_id = row.author_id.split('_')[1];
          isWebhook = true;
        }

        let author = accountMap.get(row.author_id);

        if (!author) {
          author = {
            id: '456226577798135808',
            username: 'Deleted User',
            discriminator: '0000',
            avatar: null,
            premium: false,
            bot: false,
            flags: 0,
          };
        } else if (author && author.webhook && webhookRawId) {
          author.id = webhookRawId.split('_')[2];
          webhookRawId = null;
        }

        const mentions_data = parseMentions(row.content);
        const mentions = [];

        if (mentions_data.mentions && mentions_data.mentions.length > 0) {
          for (const mention_id of mentions_data.mentions) {
            const mention = accountMap.get(mention_id);

            if (mention) {
              mentions.push(mention);
            }
          }
        }

        const messageAttachments = attachmentsMap.get(row.message_id) || [];

        messages.push(
          formatMessage(
            row,
            author,
            messageAttachments,
            mentions,
            mentions_data.mention_roles,
            [],
            isWebhook,
          ),
        );
      }

      return { messages, totalCount };
    } catch (error) {
      logText(error, 'error');
      return { messages: [], totalCount: 0 };
    }
  }, //Thanks gemini
  getChannelById: async (id) => {
    try {
      if (id.includes('12792182114301050')) {
        id = '643945264868098049';
      } //special case

      const rows = await database.runQuery(
        `
                SELECT * FROM channels WHERE id = $1
            `,
        [id],
      );

      if (rows === null || rows.length === 0) {
        return null;
      }

      const row = rows[0];

     if (row.guild_id === null || row.guild_id === 'NULL' || row.guild_id === '') {
        //dm channel / group dm

        const privChannel = {
          id: row.id,
          guild_id: null,
          type: row.type,
          last_message_id: row.last_message_id ?? '0',
        };

        if (privChannel.type === 1) {
          const dm_info = await database.getDMInfo(privChannel.id);
          const recipientIDs = dm_info.recipients;
          const recipients = [];
          for (let i = 0; i < recipientIDs.length; i++) {
            const user = await database.getAccountByUserId(recipientIDs[i]);
            if (user) recipients.push(miniUserObject(user));
            else recipients.push({ id: recipientIDs[i], username: 'Deleted User', discriminator: '0000', avatar: null, bot: false }); // fallback for deleted users
          }

          if (dm_info != null) {
            privChannel.recipients = recipients;
          }
        }

        if (privChannel.type === 3) {
          const group_info = await database.getGroupDMInfo(privChannel.id);
          if (group_info != null) {
            const recipientIDs = JSON.parse(group_info.recipients);
            const recipients = [];
            for (let i = 0; i < group_info.recipients.length; i++) {
              const user = await database.getAccountByUserId(recipientIDs[i]);
              if (user) recipients.push(miniUserObject(user));
            }

            privChannel.icon = group_info.icon;
            privChannel.name = group_info.name;
            privChannel.owner_id = group_info.owner_id;
            privChannel.recipients = recipients;
          }
        }

        delete privChannel.guild_id;

        return privChannel;
      }

      const overwrites = [];

      if (row.permission_overwrites && row.permission_overwrites.includes(':')) {
        for (var overwrite of row.permission_overwrites.split(':')) {
          const role_id = overwrite.split('_')[0];
          const allow_value = overwrite.split('_')[1];
          const deny_value = overwrite.split('_')[2];

          overwrites.push({
            id: role_id,
            allow: parseInt(allow_value),
            deny: parseInt(deny_value),
            type: overwrite.split('_')[3] ? overwrite.split('_')[3] : 'role',
          });
        }
      } else if (row.permission_overwrites && row.permission_overwrites != null) {
        const overwrite = rows[0].permission_overwrites;
        const role_id = overwrite.split('_')[0];
        const allow_value = overwrite.split('_')[1];
        const deny_value = overwrite.split('_')[2];

        overwrites.push({
          id: role_id,
          allow: parseInt(allow_value),
          deny: parseInt(deny_value),
          type: overwrite.split('_')[3] ? overwrite.split('_')[3] : 'role',
        });
      }

      return {
        id: row.id,
        name: row.name,
        ...((parseInt(row.type) === 0 ||
          parseInt(row.type) === 2 ||
          parseInt(row.type) === 5 ||
          parseInt(row.type) === 4) && {
          guild_id: row.guild_id,
        }),
        ...((parseInt(row.type) === 0 || parseInt(row.type) === 2 || parseInt(row.type) === 5) && {
          parent_id: row.parent_id,
        }),
        type: parseInt(row.type),
        ...(parseInt(row.type) === 0 && {
          topic: row.topic,
          rate_limit_per_user: row.rate_limit_per_user,
          nsfw: row.nsfw ?? false,
          last_message_id: row.last_message_id,
        }),
        ...(parseInt(row.type) === 2 && {
          bitrate: row.bitrate,
          user_limit: row.user_limit,
        }),
        permission_overwrites: overwrites,
        position: row.position,
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getGuildById: async (id) => {
    const guildRows = await database.runQuery(
      `
                SELECT * FROM guilds WHERE id = $1
        `,
      [id],
    );

    try {
      if (guildRows === null || guildRows.length === 0) {
        return null;
      }

      const guildRow = guildRows[0];

      const [channelRows, roleRows, memberRows, webhookRows, auditLogRows] = await Promise.all([
        database.runQuery(`SELECT * FROM channels WHERE guild_id = $1`, [id]),
        database.runQuery(`SELECT * FROM roles WHERE guild_id = $1`, [id]),
        database.runQuery(`SELECT * FROM members WHERE guild_id = $1`, [id]),
        database.runQuery(`SELECT * FROM webhooks WHERE guild_id = $1`, [id]),
        database.runQuery(`SELECT * FROM audit_logs WHERE guild_id = $1`, [id]),
      ]);

      const roles = [];

      if (roleRows && roleRows.length > 0) {
        for (const row of roleRows) {
          roles.push({
            id: row.role_id,
            name: row.name,
            permissions: row.permissions,
            position: row.position,
            color: row.color,
            hoist: row.hoist,
            mentionable: row.mentionable,
          });
        }
      }

      const userIds = new Set();

      if (memberRows) {
        memberRows.forEach((row) => userIds.add(row.user_id));
      }

      if (webhookRows) {
        webhookRows.forEach((row) => userIds.add(row.creator_id));
      }

      const userIdsArr = [...userIds];
      const userAccounts = await database.getAccountsByIds(userIdsArr);
      const usersMap = new Map(userAccounts.map((user) => [user.id, user]));

      const members = [];

      if (memberRows && memberRows.length > 0) {
        for (const row of memberRows) {
          const user = usersMap.get(row.user_id);

          if (!user) continue;

          let member_roles = JSON.parse(row.roles) ?? [];

          member_roles = member_roles.filter(
            (role_id) => roles.find((guild_role) => guild_role.id === role_id) !== undefined,
          );
          member_roles = member_roles.filter((x) => x !== id);

          members.push({
            id: user.id,
            nick: row.nick,
            deaf: row.deaf,
            mute: row.mute,
            roles: member_roles,
            joined_at: row.joined_at,
            user: miniUserObject(user),
          });
        }
      }

      const webhooks = [];

      if (webhookRows !== null) {
        for (const row of webhookRows) {
          const webhookAuthor = usersMap.get(row.creator_id);

          if (!webhookAuthor) continue;

          webhooks.push({
            guild_id: id,
            channel_id: row.channel_id,
            id: row.id,
            token: row.token,
            avatar: row.avatar,
            name: row.name,
            user: miniUserObject(webhookAuthor),
            type: 1,
            application_id: null,
          });
        }
      }

      const channels = [];

      if (channelRows && channelRows.length > 0) {
        for (var row of channelRows) {
          if (!row) continue;

          const overwrites = [];

          if (row.permission_overwrites && row.permission_overwrites.includes(':')) {
            for (var overwrite of row.permission_overwrites.split(':')) {
              const role_id = overwrite.split('_')[0];
              const allow_value = overwrite.split('_')[1];
              const deny_value = overwrite.split('_')[2];

              overwrites.push({
                id: role_id,
                allow: parseInt(allow_value),
                deny: parseInt(deny_value),
                type: overwrite.split('_')[3] ? overwrite.split('_')[3] : 'role',
              });
            }
          } else if (
            row.permission_overwrites &&
            row.permission_overwrites != null &&
            row.permission_overwrites != 'NULL'
          ) {
            const overwrite = row.permission_overwrites;
            const role_id = overwrite.split('_')[0];
            const allow_value = overwrite.split('_')[1];
            const deny_value = overwrite.split('_')[2];

            overwrites.push({
              id: role_id,
              allow: parseInt(allow_value),
              deny: parseInt(deny_value),
              type: overwrite.split('_')[3] ? overwrite.split('_')[3] : 'role',
            });
          }

          const channel_obj = {
            id: row.id,
            name: row.name,
            ...((parseInt(row.type) === 0 ||
              parseInt(row.type) === 2 ||
              parseInt(row.type) === 5 ||
              parseInt(row.type) === 4) && {
              guild_id: row.guild_id,
            }),
            ...((parseInt(row.type) === 0 ||
              parseInt(row.type) === 2 ||
              parseInt(row.type) === 5) && {
              parent_id: row.parent_id,
            }),
            type: parseInt(row.type),
            ...(parseInt(row.type) === 0 && {
              topic: row.topic,
              rate_limit_per_user: row.rate_limit_per_user,
              nsfw: row.nsfw ?? false,
              last_message_id: row.last_message_id,
            }),
            ...(parseInt(row.type) === 2 && {
              bitrate: row.bitrate,
              user_limit: row.user_limit,
            }),
            permission_overwrites: overwrites,
            position: row.position,
          };

          if (parseInt(row.type) === 4) {
            delete channel_obj.parent_id;
          }

          channels.push(channel_obj);
        }
      }

      let audit_logs = [];

      if (auditLogRows && auditLogRows.length > 0) {
        audit_logs = auditLogRows.map((row) => ({
          id: row.id,
          //guild_id: row.guild_id,
          action_type: row.action_type,
          target_id: row.target_id,
          user_id: row.user_id,
          changes: row.changes ? row.changes : [],
        }));
      }

      const emojis = JSON.parse(guildRow.custom_emojis); //make this jsonb in the future

      for (var emoji of emojis) {
        emoji.roles = [];
        emoji.require_colons = true;
        emoji.managed = false;
        emoji.allNamesString = `:${emoji.name}:`;
      }

      const presences = [];

      for (var member of members) {
        const sessions = global.userSessions.get(member.id);
        if (global.userSessions.size === 0 || !sessions) {
          presences.push({
            game_id: null,
            status: 'offline',
            activities: [],
            user: miniUserObject(member.user),
          });
        } else {
          const session = sessions[sessions.length - 1];
          if (!session.presence) {
            presences.push({
              game_id: null,
              status: 'offline',
              activities: [],
              user: miniUserObject(member.user),
            });
          } else presences.push(session.presence);
        }
      }

      return {
        id: guildRow.id,
        name: guildRow.name,
        icon: guildRow.icon,
        splash: guildRow.splash,
        banner: guildRow.banner,
        region: guildRow.region,
        owner_id: guildRow.owner_id,
        afk_channel_id: guildRow.afk_channel_id,
        afk_timeout: guildRow.afk_timeout,
        channels: channels,
        exclusions: guildRow.exclusions ? JSON.parse(guildRow.exclusions) : [],
        member_count: members.length,
        members: members,
        large: false,
        roles: roles,
        emojis: emojis,
        webhooks: webhooks,
        presences: presences,
        voice_states: global.guild_voice_states.get(guildRow.id) || [],
        vanity_url_code: guildRow.vanity_url,
        creation_date: guildRow.creation_date,
        features: guildRow.features ? JSON.parse(guildRow.features) : [],
        default_message_notifications: guildRow.default_message_notifications ?? 0,
        joined_at: new Date().toISOString(), //to-do get this from members row
        verification_level: guildRow.verification_level ?? 0,
        explicit_content_filter: guildRow.explicit_content_filter ?? 0,
        system_channel_id: guildRow.system_channel_id,
        audit_logs: audit_logs,
        premium_tier: guildRow.premium_tier,
        premium_subscription_count: guildRow.premium_subscription_count,
        premium_progress_bar_enabled: guildRow.premium_progress_bar_enabled,
      };
    } catch (error) {
      logText(error, 'error');

      return {
        id: id,
        unavailable: true,
      }; //fallback ?
    }
  },
  getGuildsByIds: async (ids) => {
    try {
      if (!ids || ids.length === 0) {
        return [];
      }

      const [guildRows, channelRows, roleRows, memberRows, webhookRows, auditLogRows] =
        await Promise.all([
          database.runQuery(`SELECT * FROM guilds WHERE id = ANY($1::text[])`, [ids]),
          database.runQuery(`SELECT * FROM channels WHERE guild_id = ANY($1::text[])`, [ids]),
          database.runQuery(`SELECT * FROM roles WHERE guild_id = ANY($1::text[])`, [ids]),
          database.runQuery(`SELECT * FROM members WHERE guild_id = ANY($1::text[])`, [ids]),
          database.runQuery(`SELECT * FROM webhooks WHERE guild_id = ANY($1::text[])`, [ids]),
          database.runQuery(`SELECT * FROM audit_logs WHERE guild_id = ANY($1::text[])`, [ids]),
        ]);

      if (guildRows === null || guildRows.length === 0) {
        return [];
      }

      const rolesByGuild = new Map();

      if (roleRows) {
        for (const row of roleRows) {
          const guildId = row.guild_id;

          if (!rolesByGuild.has(guildId)) {
            rolesByGuild.set(guildId, []);
          }

          rolesByGuild.get(guildId).push({
            id: row.role_id,
            name: row.name,
            permissions: row.permissions,
            position: row.position,
            color: row.color,
            hoist: row.hoist,
            mentionable: row.mentionable,
          });
        }
      }

      const userIds = new Set();

      if (memberRows) {
        memberRows.forEach((row) => userIds.add(row.user_id));
      }

      if (webhookRows) {
        webhookRows.forEach((row) => userIds.add(row.creator_id));
      }

      const userAccounts = await database.getAccountsByIds([...userIds]);
      const usersMap = new Map(userAccounts.map((user) => [user.id, user]));

      const membersByGuild = new Map();

      if (memberRows) {
        for (const row of memberRows) {
          const guildId = row.guild_id;
          const user = usersMap.get(row.user_id);
          const guildRoles = rolesByGuild.get(guildId) || [];

          if (!user) continue;

          let member_roles = JSON.parse(row.roles) ?? [];

          member_roles = member_roles.filter(
            (role_id) => guildRoles.find((guild_role) => guild_role.id === role_id) !== undefined,
          );
          member_roles = member_roles.filter((x) => x !== guildId);

          if (!membersByGuild.has(guildId)) {
            membersByGuild.set(guildId, []);
          }

          membersByGuild.get(guildId).push({
            id: user.id,
            nick: row.nick,
            deaf: row.deaf,
            mute: row.mute,
            roles: member_roles,
            joined_at: row.joined_at,
            user: miniUserObject(user),
          });
        }
      }

      const webhooksByGuild = new Map();

      if (webhookRows) {
        for (const row of webhookRows) {
          const guildId = row.guild_id;
          const webhookAuthor = usersMap.get(row.creator_id);

          if (!webhookAuthor) continue;

          if (!webhooksByGuild.has(guildId)) webhooksByGuild.set(guildId, []);

          webhooksByGuild.get(guildId).push({
            guild_id: guildId,
            channel_id: row.channel_id,
            id: row.id,
            token: row.token,
            avatar: row.avatar,
            name: row.name,
            user: miniUserObject(webhookAuthor),
            type: 1,
            application_id: null,
          });
        }
      }

      const channelsByGuild = new Map();

      if (channelRows) {
        for (var row of channelRows) {
          const guildId = row.guild_id;

          if (!row) continue;

          const overwrites = [];

          if (row.permission_overwrites && row.permission_overwrites.includes(':')) {
            for (var overwrite of row.permission_overwrites.split(':')) {
              const role_id = overwrite.split('_')[0];
              const allow_value = overwrite.split('_')[1];
              const deny_value = overwrite.split('_')[2];
              overwrites.push({
                id: role_id,
                allow: parseInt(allow_value),
                deny: parseInt(deny_value),
                type: overwrite.split('_')[3] ? overwrite.split('_')[3] : 'role',
              });
            }
          } else if (row.permission_overwrites && row.permission_overwrites != null) {
            const overwrite = row.permission_overwrites;
            const role_id = overwrite.split('_')[0];
            const allow_value = overwrite.split('_')[1];
            const deny_value = overwrite.split('_')[2];
            overwrites.push({
              id: role_id,
              allow: parseInt(allow_value),
              deny: parseInt(deny_value),
              type: overwrite.split('_')[3] ? overwrite.split('_')[3] : 'role',
            });
          }

          const channel_obj = {
            id: row.id,
            name: row.name,
            ...((parseInt(row.type) === 0 ||
              parseInt(row.type) === 2 ||
              parseInt(row.type) === 5 ||
              parseInt(row.type) === 4) && {
              guild_id: guildId,
            }),
            ...((parseInt(row.type) === 0 ||
              parseInt(row.type) === 2 ||
              parseInt(row.type) === 5) && {
              parent_id: row.parent_id,
            }),
            type: parseInt(row.type),
            ...(parseInt(row.type) === 0 && {
              topic: row.topic,
              rate_limit_per_user: row.rate_limit_per_user,
              nsfw: row.nsfw ?? false,
              last_message_id: row.last_message_id,
            }),
            ...(parseInt(row.type) === 2 && {
              bitrate: row.bitrate,
              user_limit: row.user_limit,
            }),
            permission_overwrites: overwrites,
            position: row.position,
          };

          if (parseInt(row.type) === 4) {
            delete channel_obj.parent_id;
          }

          if (!channelsByGuild.has(guildId)) {
            channelsByGuild.set(guildId, []);
          }

          channelsByGuild.get(guildId).push(channel_obj);
        }
      }

      const auditLogsByGuild = new Map();

      if (auditLogRows) {
        for (const row of auditLogRows) {
          const guildId = row.guild_id;

          if (!auditLogsByGuild.has(guildId)) {
            auditLogsByGuild.set(guildId, []);
          }

          auditLogsByGuild.get(guildId).push({
            id: row.id,
            //guild_id: guildId,
            action_type: row.action_type,
            target_id: row.target_id,
            user_id: row.user_id,
            changes: row.changes ? row.changes : [],
          });
        }
      }

      const retGuilds = [];

      for (const guildRow of guildRows) {
        const guildId = guildRow.id;

        const roles = rolesByGuild.get(guildId) || [];
        const members = membersByGuild.get(guildId) || [];
        const webhooks = webhooksByGuild.get(guildId) || [];
        const channels = channelsByGuild.get(guildId) || [];
        const audit_logs = auditLogsByGuild.get(guildId) || [];

        const emojis = JSON.parse(guildRow.custom_emojis);

        for (var emoji of emojis) {
          emoji.roles = [];
          emoji.require_colons = true;
          emoji.managed = false;
          emoji.allNamesString = `:${emoji.name}:`;
        }

        const presences = [];

        for (var member of members) {
          const sessions = global.userSessions.get(member.id);
          if (global.userSessions.size === 0 || !sessions) {
            presences.push({
              game_id: null,
              status: 'offline',
              activities: [],
              user: miniUserObject(member.user),
            });
          } else {
            const session = sessions[sessions.length - 1];
            if (!session.presence) {
              presences.push({
                game_id: null,
                status: 'offline',
                activities: [],
                user: miniUserObject(member.user),
              });
            } else presences.push(session.presence);
          }
        }

        retGuilds.push({
          id: guildId,
          name: guildRow.name,
          icon: guildRow.icon,
          splash: guildRow.splash,
          banner: guildRow.banner,
          description: '', // we should also add descriptions to guild like we would do to banners
          region: guildRow.region,
          owner_id: guildRow.owner_id,
          afk_channel_id: guildRow.afk_channel_id,
          afk_timeout: guildRow.afk_timeout,
          channels: channels,
          exclusions: guildRow.exclusions ? JSON.parse(guildRow.exclusions) : [],
          member_count: members.length,
          members: members,
          large: false, //When is large set to true?
          roles: roles,
          emojis: emojis,
          webhooks: webhooks,
          presences: presences,
          voice_states: global.guild_voice_states.get(guildId) || [],
          vanity_url_code: guildRow.vanity_url,
          creation_date: guildRow.creation_date,
          features: guildRow.features ? JSON.parse(guildRow.features) : [],
          default_message_notifications: guildRow.default_message_notifications ?? 0,
          joined_at: new Date().toISOString(), //to-do get this from members row
          verification_level: guildRow.verification_level ?? 0,
          explicit_content_filter: guildRow.explicit_content_filter ?? 0,
          system_channel_id: guildRow.system_channel_id,
          audit_logs: audit_logs,
          // v9 responses
          premium_tier: guildRow.premium_tier,
          premium_subscription_count: guildRow.premium_subscription_count,
          premium_progress_bar_enabled: guildRow.premium_progress_bar_enabled,
          stickers: [],
          threads: [],
        });
      }

      return retGuilds;
    } catch (error) {
      logText(error, 'error');

      return []; //fallback ?
    }
  },
  transferGuildOwnership: async (guild_id, new_owner) => {
    try {
      await database.runQuery(`UPDATE guilds SET owner_id = $1 WHERE id = $2`, [
        new_owner,
        guild_id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getUsersGuilds: async (id) => {
    try {
      const members = await database.runQuery(
        `
                SELECT guild_id FROM members WHERE user_id = $1
            `,
        [id],
      );

      if (members === null || members.length === 0) {
        return [];
      }

      const guildIds = members.map((member) => member.guild_id);
      const guilds = await database.getGuildsByIds(guildIds);

      return guilds;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  },
  updateGuildWidget: async (guild_id, channel_id, enabled) => {
    try {
      if (channel_id == null) {
        channel_id = null;
      }

      await database.runQuery(
        `UPDATE widgets SET channel_id = $1, enabled = $2 WHERE guild_id = $3`,
        [channel_id, enabled, guild_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getGuildWidget: async (guild_id) => {
    try {
      const rows = await database.runQuery(`SELECT * FROM widgets WHERE guild_id = $1`, [guild_id]);

      if (rows == null || rows.length == 0) {
        return null;
      }

      return {
        channel_id: rows[0].channel_id,
        enabled: rows[0].enabled,
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getChannelPermissionOverwrites: async (guild, channel_id) => {
    try {
      const channel = guild.channels.find((x) => x.id === channel_id);

      if (channel == null || !channel.permission_overwrites) {
        return [];
      }

      if (channel.permission_overwrites.length == 0) {
        return [];
      }

      return channel.permission_overwrites;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  },
  getInvite: async (code, with_counts = false) => {
    try {
      //To-do: something with with_counts going forward
      //The long SQL query of DOOM. (Gemini did help with this, I'm not going to take all credit here - I fucking hate SQL - Using joins always confuses the fuck out of me since I never seem to remember the order in which you do it
      const rows = await database.runQuery(
        `SELECT i.code, i.temporary, i.revoked, i.maxage, i.maxuses, i.uses, i.createdat, u.id AS inviter_id, u.username, u.discriminator, u.avatar, g.id AS guild_id, g.name AS guild_name, g.icon AS guild_icon, g.splash AS guild_splash, g.owner_id, g.verification_level, g.features, c.id AS channel_id, c.name AS channel_name, c.type AS channel_type FROM (SELECT code, inviter_id, guild_id, channel_id, temporary, revoked, maxage, maxuses, uses, createdat FROM invites WHERE code = $1 UNION ALL SELECT vanity_url AS code, NULL as inviter_id, id as guild_id, NULL as channel_id, FALSE, FALSE, 0, 0, 0, creation_date FROM guilds WHERE vanity_url = $1 AND NOT EXISTS (SELECT 1 FROM invites WHERE code = $1)) i LEFT JOIN users u ON i.inviter_id = u.id INNER JOIN guilds g ON i.guild_id = g.id INNER JOIN channels c ON c.id = COALESCE(i.channel_id, (SELECT id FROM channels WHERE guild_id = g.id AND type = 0 ORDER BY position ASC LIMIT 1)) LIMIT 1`,
        [code],
      );

      if (rows == null || rows.length == 0) {
        return null;
      }

      const data = rows[0];

      let expiration_date = null;

      //Since we forced vanity urls to force back at max age 0, check if its above before doing any further logic
      if (data.maxage > 0) {
        const expiryTime = new Date(data.createdat).getTime() + data.maxage * 1000;
        expiration_date = new Date(expiryTime).toISOString();

        if (Date.now() >= expiryTime) {
          await database.runQuery(`DELETE FROM invites WHERE code = $1`, [code]);
          return null;
        }
      }

      const retObject = {
        code: data.code,
        inviter: data.inviter_id
          ? {
              id: data.inviter_id,
              username: data.username,
              discriminator: data.discriminator,
              avatar: data.avatar,
            }
          : null,
        expires_at: expiration_date,
        guild: {
          id: data.guild_id,
          name: data.guild_name,
          icon: data.guild_icon,
          splash: data.guild_splash,
          owner_id: data.owner_id,
          features: data.features ? JSON.parse(data.features) : [],
          //roles: guildRoles - I dont know if we should even return this?
        },
        channel: {
          id: data.channel_id,
          guild_id: data.guild_id,
          name: data.channel_name,
          type: data.channel_type,
        },
        uses: data.uses,
        max_uses: data.max_uses,
        //with_counts would return approximate_presence_count: online_count, and approximate_member_count: member_count_total,
      };

      return retObject;
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  }, //rewrite asap
  isBannedFromGuild: async (guild_id, user_id) => {
    try {
      const rows = await database.runQuery(
        `
                SELECT user_id FROM bans WHERE user_id = $1 AND guild_id = $2 LIMIT 1
            `,
        [user_id, guild_id],
      );

      return rows !== null && rows.length > 0;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  useInvite: async (invite, guild, user_id) => {
    try {
      const member = guild.members.find((x) => x.id === user_id);

      if (member != null) {
        return false;
      } //So for now the API will return invalid invite if theyre already in the server - but figure out the proper response, otherwise they can, and probably will at some point spam join messages.

      if (invite.max_uses && invite.max_uses != 0 && invite.uses >= invite.max_uses) {
        await database.deleteInvite(invite.code);

        return false;
      }

      const isBanned = await database.isBannedFromGuild(guild.id, user_id);

      if (isBanned) {
        return false;
      }

      const joinedGuild = await database.joinGuild(user_id, guild);

      if (!joinedGuild) {
        return false;
      }

      invite.uses++;

      await database.runQuery(`UPDATE invites SET uses = $1 WHERE code = $2`, [
        invite.uses,
        invite.code,
      ]); //look into NaN issue here sometimes

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  clearRoles: async (guild, user_id) => {
    try {
      const member = guild.members.find((x) => x.id === user_id);

      if (!member) {
        return false;
      }

      if (member.roles.length == 0) {
        return false;
      }

      await database.runQuery(`UPDATE members SET roles = $1 WHERE user_id = $2`, [null, user_id]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  setRoles: async (guild, role_ids, user_id) => {
    try {
      if (!user_id || !guild.id) return false;

      const guild_id = guild.id;

      const saveRoles = [];

      for (var role of role_ids) {
        if (!guild.roles.find((x) => x.id === role)) {
          continue; //Invalid role
        }

        if (role === guild_id) {
          continue; //everyone has the everyone role silly
        }

        saveRoles.push(role);
      }

      await database.runQuery(
        `UPDATE members SET roles = $1 WHERE user_id = $2 AND guild_id = $3`,
        [JSON.stringify(saveRoles), user_id, guild_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  joinGuild: async (user_id, guild) => {
    try {
      const member = guild.members.find((x) => x.id === user_id);

      if (member != null) {
        return false;
      }

      const roles = guild.roles;

      if (!roles || roles.length == 0) {
        return false;
      }

      const date = new Date().toISOString();

      await database.runQuery(
        `INSERT INTO members (guild_id, user_id, nick, roles, joined_at, deaf, mute) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [guild.id, user_id, null, '[]', date, 0, 0],
      );

      const userRows = await database.runQuery(`SELECT settings, bot FROM users WHERE id = $1`, [
        user_id,
      ]);

      if (userRows && userRows.length > 0 && !userRows[0].bot) {
        const settings = JSON.parse(userRows[0].settings);
        if (settings.default_guilds_restricted) {
          if (!settings.restricted_guilds.includes(guild.id)) {
            settings.restricted_guilds.push(guild.id);
            await database.runQuery(`UPDATE users SET settings = $1 WHERE id = $2`, [
              JSON.stringify(settings),
              user_id,
            ]);
          }
        }
      }

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getChannelInvites: async (channel_id) => {
    try {
      const rows = await database.runQuery(`SELECT * FROM invites WHERE channel_id = $1`, [
        channel_id,
      ]);

      if (rows == null || rows.length == 0) {
        return [];
      }

      const ret = [];

      for (var row of rows) {
        const invite = await database.getInvite(row.code);

        if (invite != null) {
          ret.push(invite);
        }
      }

      return ret;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  }, //rewrite asap
  deleteInvite: async (code) => {
    try {
      await database.runQuery(`DELETE FROM invites WHERE code = $1`, [code]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getGuildInvites: async (guild_id) => {
    try {
      const rows = await database.runQuery(`SELECT * FROM invites WHERE guild_id = $1`, [guild_id]);

      if (rows == null || rows.length == 0) {
        return [];
      }

      const ret = [];

      for (var row of rows) {
        const invite = await database.getInvite(row.code);

        if (invite != null) {
          ret.push(invite);
        }
      }

      return ret;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  }, //rewrite asap
  createInvite: async (
    guild,
    channel,
    inviter,
    temporary,
    maxUses,
    maxAge,
    xkcdpass,
    force_regenerate,
  ) => {
    try {
      let code = '';

      if (xkcdpass) {
        code = generateMemorableInviteCode();
      } else {
        code = generateString(16);
      }

      const date = new Date().toISOString();

      if (!force_regenerate) {
        const existingInvites = await database.runQuery(
          `SELECT * FROM invites WHERE guild_id = $1 AND channel_id = $2 AND revoked = $3 AND inviter_id = $4 AND maxuses = $5 AND xkcdpass = $6 AND maxage = $7`,
          [guild.id, channel.id, temporary, inviter.id, maxUses, xkcdpass, maxAge],
        );

        if (existingInvites && existingInvites.length > 0) {
          const invite = await database.getInvite(existingInvites[0].code); //really work on reducing the amount of shit like this
          return invite;
        }
      }

      await database.runQuery(
        `INSERT INTO invites (guild_id, channel_id, code, temporary, revoked, inviter_id, uses, maxuses, maxage, xkcdpass, createdat) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [guild.id, channel.id, code, temporary, 0, inviter.id, 0, maxUses, maxAge, xkcdpass, date],
      );

      return {
        code: code,
        temporary: temporary,
        revoked: false,
        inviter: miniUserObject(inviter),
        max_age: parseInt(maxAge),
        max_uses: parseInt(maxUses),
        uses: 0,
        guild: {
          id: guild.id,
          name: guild.name,
          icon: guild.icon,
          splash: guild.splash ?? null,
          owner_id: guild.owner_id,
          features: guild.features ?? [],
        },
        channel: {
          id: channel.id,
          name: channel.name,
          guild_id: guild.id,
          type: channel.type,
        },
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  updateSettings: async (user_id, new_settings) => {
    try {
      await database.runQuery(
        `
                UPDATE users SET settings = $1 WHERE id = $2
            `,
        [JSON.stringify(new_settings), user_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  deleteRole: async (role_id) => {
    try {
      await database.runQuery(`DELETE FROM roles WHERE role_id = $1`, [role_id]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  createRole: async (guild_id, name, position) => {
    try {
      const role_id = generate();

      const default_permissions = 73468929; //READ, SEND, READ MSG HISTORY, CREATE INSTANT INVITE, SPEAK, MUTE_MEMBERS, CHANGE_NICKNAME

      await database.runQuery(
        `INSERT INTO roles (guild_id, role_id, name, permissions, position) VALUES ($1, $2, $3, $4, $5)`,
        [guild_id, role_id, name, default_permissions, position],
      );

      return {
        id: role_id,
        name: name,
        permissions: default_permissions,
        position: position,
        color: 0,
        hoist: false,
        mentionable: false,
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  updateRole: async (role) => {
    try {
      await database.runQuery(
        `UPDATE roles SET name = $1, permissions = $2, position = $3, color = $4, hoist = $5, mentionable = $6 WHERE role_id = $7`,
        [
          role.name,
          role.permissions,
          role.position,
          role.color,
          role.hoist ? 1 : 0,
          role.mentionable ? 1 : 0,
          role.id,
        ],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  deleteChannelPermissionOverwrite: async (guild, channel_id, overwrite) => {
    try {
      const current_overwrites = await database.getChannelPermissionOverwrites(guild, channel_id);

      const findOverwrite = current_overwrites.findIndex((x) => x.id == overwrite.id);

      if (findOverwrite === -1) {
        return false;
      }

      current_overwrites.splice(findOverwrite, 1);

      const serialized = SerializeOverwritesToString(current_overwrites);

      await database.runQuery(
        `
                UPDATE channels SET permission_overwrites = $1 WHERE id = $2
            `,
        [serialized, channel_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  }, //rewrite
  updateChannelPermissionOverwrites: async (guild, channel_id, overwrites) => {
    try {
      const current_overwrites = await database.getChannelPermissionOverwrites(guild, channel_id);

      for (var i = 0; i < overwrites.length; i++) {
        const overwrite = overwrites[i];
        const old_overwrite = current_overwrites.findIndex((x) => x.id == overwrite.id);

        if (old_overwrite === -1) {
          current_overwrites.push(overwrite);
        } else {
          current_overwrites[old_overwrite] = overwrite;
        }
      }

      const serialized = SerializeOverwritesToString(current_overwrites);

      await database.runQuery(
        `
                UPDATE channels SET permission_overwrites = $1 WHERE id = $2
            `,
        [serialized, channel_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  }, //rewrite
  leaveGuild: async (user_id, guild_id) => {
    try {
      await database.runQuery(`DELETE FROM members WHERE guild_id = $1 AND user_id = $2`, [
        guild_id,
        user_id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  deleteChannel: async (channel_id) => {
    try {
      const [_, messages] = await Promise.all([
        database.runQuery(`DELETE FROM invites WHERE channel_id = $1`, [channel_id]),
        database.runQuery(`SELECT * FROM messages WHERE channel_id = $1`, [channel_id]),
      ]);

      if (messages && messages.length > 0) {
        await Promise.all(messages.map((message) => database.deleteMessage(message.message_id)));
      }

      try {
        await fsPromises.rm(`./www_dynamic/attachments/${channel_id}`, {
          recursive: true,
          force: true,
        });
      } catch (error) {}

      await Promise.all([
        database.runQuery(`DELETE FROM permissions WHERE channel_id = $1`, [channel_id]),
        database.runQuery(`DELETE FROM channels WHERE id = $1`, [channel_id]),
        database.runQuery(`DELETE FROM dm_channels WHERE id = $1`, [channel_id]),
        database.runQuery(`DELETE FROM group_channels WHERE id = $1`, [channel_id]),
        database.runQuery(`DELETE FROM acknowledgements WHERE channel_id = $1`, [channel_id]),
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  deleteMessage: async (message_id) => {
    try {
      const message = await database.getMessageById(message_id);

      if (message == null) {
        return false;
      }

      await database.runQuery(`DELETE FROM messages WHERE message_id = $1`, [message_id]);

      const attachments = await database.runQuery(
        `SELECT * FROM attachments WHERE message_id = $1`,
        [message_id],
      );

      if (attachments && attachments.length > 0) {
        await Promise.all(
          attachments.map(async (attachment) => {
            const attachmentPath = `./www_dynamic/attachments/${message.channel_id}/${attachment.attachment_id}`;

            try {
              const files = await fsPromises.readdir(attachmentPath);

              await Promise.all(files.map((file) => fsPromises.unlink(join(attachmentPath, file))));

              await fsPromises.rmdir(attachmentPath);

              await database.runQuery(`DELETE FROM attachments WHERE attachment_id = $1`, [
                attachment.attachment_id,
              ]);
            } catch (error) {}
          }),
        );
      }

      await database.runQuery(
        `
                UPDATE channels 
                SET last_message_id = (
                    SELECT message_id 
                    FROM messages 
                    WHERE channel_id = $1 
                    ORDER BY message_id DESC 
                    LIMIT 1
                ) 
                WHERE id = $1 AND last_message_id = $2
            `,
        [message.channel_id, message_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  }, //rewrite asap
  deleteGuild: async (guild_id) => {
    try {
      const assetTypes = ['banners', 'icons', 'splashes'];

      await Promise.all(
        assetTypes.map(async (type) => {
          const dirPath = join('./www_dynamic', type, guild_id.toString());

          try {
            await fsPromises.rm(dirPath, {
              recursive: true,
              force: true,
            });
          } catch (err) {
            logText(
              `Failed to delete www_dynamic/${type} for guild ${guild_id}: ${err.message}`,
              'error',
            );
          }
        }),
      );

      await database.runQuery(`DELETE FROM guilds WHERE id = $1`, [guild_id]);

      const channelRows = await database.runQuery(`SELECT id FROM channels WHERE guild_id = $1`, [
        guild_id,
      ]);

      if (channelRows && channelRows.length > 0) {
        await Promise.all(channelRows.map((channel) => database.deleteChannel(channel.id)));
      }

      await Promise.all([
        database.runQuery(`DELETE FROM messages WHERE guild_id = $1`, [guild_id]),
        database.runQuery(`DELETE FROM roles WHERE guild_id = $1`, [guild_id]),
        database.runQuery(`DELETE FROM members WHERE guild_id = $1`, [guild_id]),
        database.runQuery(`DELETE FROM widgets WHERE guild_id = $1`, [guild_id]),
        database.runQuery(`DELETE FROM bans WHERE guild_id = $1`, [guild_id]),
        database.runQuery(`DELETE FROM webhooks WHERE guild_id = $1`, [guild_id]),
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getDMInfo: async (channel_id) => {
    try {
      const rows = await database.runQuery(`SELECT user1, user2 FROM dm_channels WHERE id = $1`, [
        channel_id,
      ]);

      if (rows === null || rows.length === 0) {
        return null;
      }

      if (rows[0].user1 && rows[0].user2) {
        return {
          recipients: [rows[0].user1, rows[0].user2],
        };
      }

      return null;
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getGroupDMInfo: async (channel_id) => {
    try {
      const rows = await database.runQuery(`SELECT * FROM group_channels WHERE id = $1`, [
        channel_id,
      ]);

      if (rows === null || rows.length === 0) {
        return null;
      }

      return {
        icon: rows[0].icon,
        name: rows[0].name == null ? '' : rows[0].name,
        owner_id: rows[0].owner_id,
        recipients: rows[0].recipients,
      };
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  createWebhookOverride: async (webhook_id, override_id, username, avatar_url = null) => {
    try {
      await database.runQuery(
        `INSERT INTO webhook_overrides (id, override_id, avatar_url, username) VALUES ($1, $2, $3, $4)`,
        [webhook_id, override_id, avatar_url, username],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getWebhookOverrides: async (webhook_id, override_id) => {
    try {
      const rows = await database.runQuery(
        `SELECT * FROM webhook_overrides WHERE id = $1 AND override_id = $2`,
        [webhook_id, override_id],
      );

      if (rows === null || rows.length === 0) {
        return null;
      }

      return {
        username: rows[0].username,
        avatar_url: rows[0].avatar_url,
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getNoteForUserId: async (requester_id, user_id) => {
    try {
      const rows = await database.runQuery(
        `SELECT * FROM user_notes WHERE author_id = $1 AND user_id = $2`,
        [requester_id, user_id],
      );

      if (rows === null || rows.length === 0) {
        return null;
      }

      return rows[0].note;
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  getNotesByAuthorId: async (requester_id) => {
    try {
      const rows = await database.runQuery(`SELECT * FROM user_notes WHERE author_id = $1`, [
        requester_id,
      ]);

      if (!rows || rows.length === 0) {
        return {};
      }

      const notes = {};

      for (var row of rows) {
        notes[row.user_id] = row.note;
      }

      return notes;
    } catch (error) {
      logText(error, 'error');

      return {};
    }
  },
  updateNoteForUserId: async (requester_id, user_id, new_note) => {
    try {
      const notes = await database.getNoteForUserId(requester_id, user_id);

      if (!notes) {
        await database.runQuery(
          `INSERT INTO user_notes (author_id, user_id, note) VALUES ($1, $2, $3)`,
          [requester_id, user_id, new_note === null ? null : new_note],
        );

        return true;
      }

      await database.runQuery(
        `UPDATE user_notes SET note = $1 WHERE author_id = $2 AND user_id = $3`,
        [new_note, requester_id, user_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  }, //rewrite asap
  createSystemMessage: async (guild_id, channel_id, type, props = []) => {
    //type 1 needs a different body for it to work, look into that later

    /*
        Msg type 
            0 - default
            1 - recipient add to group (GROUP DM RELATED)
            2 - recipient removed from group (GROUP DM RELATED)
            3 - call (DM / GROUP DM RELATED)
            4 - channel name change (GROUP DM RELATED)
            5 - channel icon change (GROUP DM RELATED)
            6 - pins add (SERVER)
            7 - guild member join (SERVER)
        */
    try {
      const id = generate();
      const nonce = generate();
      const author_id = props[0].id || generate();
      const date = deconstruct(id).date.toISOString();

      let mention_id = generate();

      if (type === 1) {
        mention_id = props[1].id;
      }

      await database.runQuery(
        `INSERT INTO messages (type, guild_id, message_id, channel_id, author_id, content, edited_timestamp, mention_everyone, nonce, timestamp, tts, embeds) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          type,
          guild_id,
          id,
          channel_id,
          author_id,
          type === 1 ? `<@${mention_id}>` : '',
          null,
          0,
          nonce,
          date,
          0,
          '[]',
        ],
      );

      await database.runQuery(`UPDATE channels SET last_message_id = $1 WHERE id = $2`, [
        id,
        channel_id,
      ]);

      const msg = await database.getMessageById(id);

      if (type === 1) {
        msg.mentions = [miniUserObject(props[1])];
      }

      return msg;
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  createMessage: async (
    guild_id,
    channel_id,
    author_id,
    content,
    nonce,
    attachments,
    tts,
    mentions_data,
    webhook_embeds = null,
  ) => {
    try {
      const id = generate();
      const deconstructed = deconstruct(id);
      const date = deconstructed.date.toISOString();

      if (!nonce || nonce === null) {
        nonce = null; //just make sure its null
      }

      //validate snowflakes

      const isWebhook = author_id.includes('WEBHOOK_');

      if (content == undefined) {
        content = '';
      }

      let embeds = await generateMsgEmbeds(content, attachments);

      if (webhook_embeds && Array.isArray(webhook_embeds) && webhook_embeds.length > 0) {
        embeds = webhook_embeds;
      }

      await database.runQuery(
        `INSERT INTO messages (guild_id, message_id, channel_id, author_id, content, edited_timestamp, mention_everyone, nonce, timestamp, tts, embeds) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          guild_id,
          id,
          channel_id,
          author_id,
          content,
          null,
          mentions_data.mention_everyone,
          nonce,
          date,
          tts ? 1 : 0,
          JSON.stringify(embeds),
        ],
      );

      await database.runQuery(`UPDATE channels SET last_message_id = $1 WHERE id = $2`, [
        id,
        channel_id,
      ]);

      if (attachments && Array.isArray(attachments)) {
        for (var attachment of attachments) {
          await database.runQuery(
            `INSERT INTO attachments (attachment_id, message_id, filename, height, width, size, url) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              attachment.id,
              id,
              attachment.name,
              attachment.height,
              attachment.width,
              attachment.size,
              attachment.url,
            ],
          );
        }
      }

      const msg = await database.getMessageById(id);

      const mentions = [];

      if (mentions_data.mentions && mentions_data.mentions.length > 0) {
        for (var mention_id of mentions_data.mentions) {
          const mention = await database.getAccountByUserId(mention_id);

          if (mention != null) {
            mentions.push(miniUserObject(mention));
          }
        }
      }

      msg.mentions = mentions;
      msg.mention_everyone = mentions_data.mention_everyone;
      msg.mention_roles = mentions_data.mention_roles;

      if (isWebhook) {
        msg.webhook_id = author_id.split('_')[1];
      }

      return msg;
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  }, //rewrite asap
  updateGuildVanity: async (guild_id, vanity_url) => {
    try {
      let send_vanity = null;

      if (vanity_url != null) {
        send_vanity = vanity_url;
      }

      const checkRows = await database.runQuery(
        `
                SELECT EXISTS (
                    SELECT 1 FROM guilds WHERE vanity_url = $1
                ) AS is_taken;`,
        [vanity_url],
      );

      if (checkRows && checkRows.length > 0 && checkRows[0].is_taken) {
        return 0;
      }

      await database.runQuery(`UPDATE guilds SET vanity_url = $1 WHERE id = $2`, [
        vanity_url,
        guild_id,
      ]);

      return 1; //success
    } catch (error) {
      logText(error, 'error');

      return -1; //error
    }
  },
  updateGuild: async (
    guild_id,
    afk_channel_id,
    afk_timeout,
    icon,
    splash,
    banner,
    name,
    default_message_notifications,
    verification_level,
    explicit_content_filter,
    system_channel_id,
  ) => {
    try {
      let send_icon = null;
      let send_splash = null;
      let send_banner = null;

      if (icon != null) {
        if (icon.includes('data:image')) {
          var extension = icon.split('/')[1].split(';')[0];
          var imgData = icon.replace(`data:image/${extension};base64,`, '');
          var file_name = generateString(30);
          var hash = md5(file_name);

          if (extension == 'jpeg') {
            extension = 'jpg';
          }

          send_icon = hash.toString();

          if (!existsSync(`www_dynamic/icons`)) {
            mkdirSync(`www_dynamic/icons`, { recursive: true });
          }

          if (!existsSync(`www_dynamic/icons/${guild_id}`)) {
            mkdirSync(`www_dynamic/icons/${guild_id}`, { recursive: true });

            writeFileSync(`www_dynamic/icons/${guild_id}/${hash}.${extension}`, imgData, 'base64');
          } else {
            writeFileSync(`www_dynamic/icons/${guild_id}/${hash}.${extension}`, imgData, 'base64');
          }
        } else {
          send_icon = icon;
        }
      }

      if (splash != null) {
        if (splash.includes('data:image')) {
          var extension = splash.split('/')[1].split(';')[0];
          var imgData = splash.replace(`data:image/${extension};base64,`, '');
          var file_name = generateString(30);
          var hash = md5(file_name);

          if (extension == 'jpeg') {
            extension = 'jpg';
          }

          send_splash = hash.toString();

          if (!existsSync(`www_dynamic/splashes`)) {
            mkdirSync(`www_dynamic/splashes`, { recursive: true });
          }

          if (!existsSync(`www_dynamic/splashes/${guild_id}`)) {
            mkdirSync(`www_dynamic/splashes/${guild_id}`, { recursive: true });

            writeFileSync(
              `www_dynamic/splashes/${guild_id}/${hash}.${extension}`,
              imgData,
              'base64',
            );
          } else {
            writeFileSync(
              `www_dynamic/splashes/${guild_id}/${hash}.${extension}`,
              imgData,
              'base64',
            );
          }
        } else {
          send_splash = splash;
        }
      }

      if (banner != null) {
        if (banner.includes('data:image')) {
          var extension = banner.split('/')[1].split(';')[0];
          var imgData = banner.replace(`data:image/${extension};base64,`, '');
          var file_name = generateString(30);
          var hash = md5(file_name);

          if (extension == 'jpeg') {
            extension = 'jpg';
          }

          send_banner = hash.toString();

          if (!existsSync(`www_dynamic/banners`)) {
            mkdirSync(`www_dynamic/banners`, { recursive: true });
          }

          if (!existsSync(`www_dynamic/banners/${guild_id}`)) {
            mkdirSync(`www_dynamic/banners/${guild_id}`, { recursive: true });

            writeFileSync(
              `www_dynamic/banners/${guild_id}/${hash}.${extension}`,
              imgData,
              'base64',
            );
          } else {
            writeFileSync(
              `www_dynamic/banners/${guild_id}/${hash}.${extension}`,
              imgData,
              'base64',
            );
          }
        } else {
          send_banner = banner;
        }
      }

      await database.runQuery(
        `UPDATE guilds SET name = $1, icon = $2, splash = $3, banner = $4, afk_channel_id = $5, afk_timeout = $6, default_message_notifications = $7, verification_level = $8, explicit_content_filter = $9, system_channel_id = $10 WHERE id = $11`,
        [
          name,
          send_icon,
          send_splash,
          send_banner,
          afk_channel_id,
          afk_timeout,
          default_message_notifications,
          verification_level,
          explicit_content_filter,
          system_channel_id,
          guild_id,
        ],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  createGuild: async (owner, icon, name, region, exclusions, client_date) => {
    try {
      const id = generate();
      const deconstructed = deconstruct(id);
      const date = deconstructed.date.toISOString();

      if (icon != null) {
        var extension = icon.split('/')[1].split(';')[0];
        var imgData = icon.replace(`data:image/${extension};base64,`, '');
        var file_name = generateString(30);
        var hash = md5(file_name);

        if (extension == 'jpeg') {
          extension = 'jpg';
        }

        icon = hash.toString();

        if (!existsSync(`www_dynamic/icons`)) {
          mkdirSync(`www_dynamic/icons`, { recursive: true });
        }

        if (!existsSync(`www_dynamic/icons/${id}`)) {
          mkdirSync(`www_dynamic/icons/${id}`, { recursive: true });

          writeFileSync(`www_dynamic/icons/${id}/${hash}.${extension}`, imgData, 'base64');
        } else {
          writeFileSync(`www_dynamic/icons/${id}/${hash}.${extension}`, imgData, 'base64');
        }
      }

      await database.runQuery('BEGIN');

      await database.runQuery(
        `INSERT INTO guilds (id, name, icon, region, owner_id, afk_channel_id, afk_timeout, creation_date, exclusions) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, name, icon, region, owner.id, null, 300, date, JSON.stringify(exclusions)],
      );

      let channelsResponse = [];

      if (
        (client_date.getFullYear() === 2017 && client_date.getMonth() >= 9) ||
        client_date.getFullYear() >= 2018
      ) {
        const tCatId = generate();
        const vCatId = generate();
        const genTextId = id;
        //const genTextId = generate();
        const genVoiceId = generate();

        await database.runQuery(
          `INSERT INTO channels (id, type, guild_id, name, position) VALUES ($1, 4, $2, $3, 0)`,
          [tCatId, id, 'Text Channels'],
        );
        await database.runQuery(
          `INSERT INTO channels (id, type, guild_id, parent_id, name, position) VALUES ($1, 0, $2, $3, $4, 0)`,
          [genTextId, id, tCatId, 'general'],
        );

        await database.runQuery(
          `INSERT INTO channels (id, type, guild_id, name, position) VALUES ($1, 4, $2, $3, 1)`,
          [vCatId, id, 'Voice Channels'],
        );
        await database.runQuery(
          `INSERT INTO channels (id, type, guild_id, parent_id, name, position) VALUES ($1, 2, $2, $3, $4, 0)`,
          [genVoiceId, id, vCatId, 'General'],
        );

        channelsResponse = [
          {
            id: tCatId,
            type: 4,
            name: 'Text Channels',
            position: 0,
            guild_id: id,
            permission_overwrites: [],
          },
          {
            id: genTextId,
            type: 0,
            name: 'general',
            position: 0,
            parent_id: tCatId,
            guild_id: id,
            topic: null,
            nsfw: false,
            last_message_id: '0',
            rate_limit_per_user: 0,
            permission_overwrites: [],
          },
          {
            id: vCatId,
            type: 4,
            name: 'Voice Channels',
            position: 1,
            guild_id: id,
            permission_overwrites: [],
          },
          {
            id: genVoiceId,
            type: 2,
            name: 'General',
            position: 0,
            parent_id: vCatId,
            guild_id: id,
            user_limit: 0,
            bitrate: 64000,
            permission_overwrites: [],
          },
        ];
      } else {
        // Legacy 2017
        const voiceId = generate();

        await database.runQuery(
          `INSERT INTO channels (id, type, guild_id, name, position) VALUES ($1, 0, $2, $3, 0)`,
          [id, id, 'general'],
        );

        await database.runQuery(
          `INSERT INTO channels (id, type, guild_id, name, position) VALUES ($1, 2, $2, $3, 1)`,
          [voiceId, id, 'General'],
        );

        channelsResponse = [
          {
            type: 0,
            name: 'general',
            position: 0,
            id: id,
            guild_id: id,
            permission_overwrites: [],
            topic: null,
            last_message_id: '0',
          },
          {
            type: 2,
            name: 'General',
            position: 1,
            id: voiceId,
            guild_id: id,
            permission_overwrites: [],
            bitrate: 64000,
            user_limit: 0,
          },
        ];
      }

      await database.runQuery(
        `INSERT INTO roles (guild_id, role_id, name, permissions, position) VALUES ($1, $1, '@everyone', 104193089, 0)`,
        [id],
      );
      await database.runQuery(
        `INSERT INTO members (guild_id, user_id, nick, roles, joined_at, deaf, mute) VALUES ($1, $2, null, '[]', $3, FALSE, FALSE)`,
        [id, owner.id, date],
      );
      await database.runQuery(
        `INSERT INTO widgets (guild_id, channel_id, enabled) VALUES ($1, null, FALSE)`,
        [id],
      );
      await database.runQuery('COMMIT');

      return {
        id: id,
        name: name,
        icon: icon,
        region: region,
        owner_id: owner.id,
        joined_at: date,
        afk_channel_id: null,
        afk_timeout: 300,
        verification_level: 0,
        default_message_notifications: 0,
        explicit_content_filter: 0,
        roles: [
          {
            id: id,
            name: '@everyone',
            permissions: 104193089,
            position: 0,
            color: 0,
            hoist: false,
            managed: false,
            mentionable: false,
          },
        ],
        emojis: [],
        features: [],
        application_id: null,
        widget_enabled: false,
        widget_channel_id: null,
        system_channel_id: null,
        channels: channelsResponse,
        members: [
          {
            user: miniUserObject(owner),
            nick: null,
            roles: [],
            joined_at: date,
            deaf: false,
            mute: false,
          },
        ],
        presences: [
          getUserPresence({
            user: miniUserObject(owner),
          }),
        ],
        member_count: 1,
        voice_states: [],
        large: false,
        unavailable: false,
      };
    } catch (error) {
      logText(error, 'error');

      return null;
    }
  },
  createAccount: async (username, email, password, ip, email_token = null) => {
    // New accounts via invite (unclaimed account) have null email and null password.
    try {
      const isEmailTaken = await database.runQuery(
        `
            SELECT EXISTS (
                SELECT 1 FROM users WHERE email = $1
            ) AS is_taken;`,
        [email],
      );

      if (isEmailTaken && isEmailTaken.length > 0 && isEmailTaken[0].is_taken) {
        return {
          success: false,
          reason: 'Email is already registered.',
        };
      }

      const usersRows =
        (await database.runQuery(`SELECT COUNT(*) as user_count FROM users WHERE username = $1`, [
          username,
        ])) ?? [];

      if (usersRows && usersRows.length > 0 && parseInt(usersRows[0].user_count) === 9999) {
        return {
          success: false,
          reason: 'Too many people have this username.',
        };
      }

      const salt = await genSalt(10);
      const pwHash = await hash(password ?? generateString(20), salt);
      const id = generate();
      const deconstructed = deconstruct(id);
      const date = deconstructed.date.toISOString();
      let discriminator = Math.round(Math.random() * 9999);

      while (discriminator < 1000) {
        discriminator = Math.round(Math.random() * 9999);
      }

      const token = generateToken(id, pwHash);

      await database.runQuery(
        `INSERT INTO users (id,username,discriminator,email,password,token,created_at,avatar,registration_ip,verified,email_token) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          username,
          discriminator.toString(),
          email,
          password ? pwHash : null,
          token,
          date,
          null,
          ip,
          config.email_config.enabled ? 0 : 1,
          email_token ?? null,
        ],
      );

      const userRows = await database.runQuery(`SELECT settings, bot FROM users WHERE id = $1`, [
        id,
      ]);

      if (userRows && userRows.length > 0 && !userRows[0].bot) {
        const settings = JSON.parse(userRows[0].settings);
        if (
          config.require_friendship_for_dm ||
          config.instance.flags.includes('FRIENDSHIP_FOR_DM')
        ) {
          settings.default_guilds_restricted = true;
          settings.friend_source_flags = {
            all: false,
            mutual_friends: true,
            mutual_guilds: true,
          };
          await database.runQuery(`UPDATE users SET settings = $1 WHERE id = $2`, [
            JSON.stringify(settings),
            id,
          ]);
        }
      }

      return {
        token: token,
      };
    } catch (error) {
      logText(error, 'error');

      return {
        success: false,
        reason: 'Something went wrong while creating account.',
      };
    }
  },
  doesThisMatchPassword: async (password_raw, password_hash) => {
    try {
      const comparison = compareSync(password_raw, password_hash);

      if (!comparison) {
        return false;
      }

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  setPinState: async (message_id, state) => {
    try {
      await database.runQuery(`UPDATE messages SET pinned = $1 WHERE message_id = $2`, [
        state ? 1 : 0,
        message_id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getLatestPinAcknowledgement: async (user_id, channel_id) => {
    try {
      const pinRows = await database.runQuery(
        `
                SELECT message_id FROM messages 
                WHERE channel_id = $1 AND pinned = $2 
                ORDER BY message_id DESC LIMIT 1
            `,
        [channel_id, true],
      );

      if (!pinRows || pinRows.length === 0) {
        return null;
      }

      const latestPinId = pinRows[0].message_id;

      const ackRows = await database.runQuery(
        `
                SELECT 1 FROM acknowledgements
                WHERE user_id = $1 
                AND channel_id = $2 
                AND message_id = $3
                LIMIT 1
            `,
        [user_id, channel_id, latestPinId],
      );

      if (ackRows && ackRows.length > 0) {
        return null;
      }

      return {
        id: latestPinId,
      };
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  addInstanceStaff: async (user, privilege) => {
    try {
      await database.runQuery(
        `INSERT INTO staff (user_id, privilege, audit_log) VALUES ($1, $2, $3)`,
        [user.id, privilege, '[]'],
      );

      await database.runQuery(`UPDATE users SET flags = $1 WHERE id = $2`, [
        user.flags | 1,
        user.id,
      ]); // Maybe repurpose COLLABORATOR or RESTRICTED_COLLABORATOR for either Admin and Janitor/Moderator respectively

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  updateInstanceStaff: async (user, privilege) => {
    try {
      await database.runQuery(`UPDATE staff SET privilege = $1 WHERE user_id = $2`, [
        privilege,
        user.id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  getStaffAuditLogs: async () => {
    try {
      const rows = await database.runQuery(
        `SELECT u.id, u.username, u.discriminator, s.audit_log, s.user_id FROM users AS u INNER JOIN staff AS s ON s.user_id = u.id`,
        [],
      );

      if (!rows || rows.length === 0) {
        return [];
      }

      const ret = [];

      for (const row of rows) {
        const entries = JSON.parse(row.audit_log) ?? [];

        if (entries.length > 0) {
          const completeEntries = entries.map((logEntry) => ({
            ...logEntry,
            actioned_by: {
              username: row.username,
              id: row.id,
              discriminator: row.discriminator,
            },
          }));

          ret.push(...completeEntries);
        }
      }

      return ret;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  },
  getInstanceStaff: async () => {
    try {
      const rows = await database.runQuery(
        `SELECT s.user_id, s.privilege, s.audit_log, u.username, u.discriminator, u.id, u.avatar FROM staff AS s INNER JOIN users AS u ON u.id = s.user_id`,
        [],
      );
      const ret = [];

      if (!rows || rows.length === 0) {
        return [];
      }

      for (var row of rows) {
        ret.push({
          avatar: row.avatar,
          username: row.username,
          id: row.id,
          discriminator: row.discriminator,
          staff_details: {
            privilege: row.privilege,
            audit_log: JSON.parse(row.audit_log) ?? [],
          },
        });
      }

      return ret;
    } catch (error) {
      logText(error, 'error');

      return [];
    }
  },
  removeFromStaff: async (user) => {
    try {
      await database.runQuery(`DELETE FROM staff WHERE user_id = $1`, [user.id]);

      await database.runQuery(`UPDATE users SET flags = $1 WHERE id = $2`, [
        user.flags & ~1,
        user.id,
      ]); // Maybe repurpose COLLABORATOR or RESTRICTED_COLLABORATOR for either Admin and Janitor/Moderator respectively

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  clearStaffAuditLogs: async (user_id) => {
    try {
      await database.runQuery(`UPDATE staff SET audit_log = $1 WHERE user_id = $2`, [
        '[]',
        user_id,
      ]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  updateMessage: async (message_id, new_content) => {
    try {
      const embeds = await generateMsgEmbeds(new_content);

      const date = new Date().toISOString();

      await database.runQuery(
        `UPDATE messages SET content = $1, edited_timestamp = $2, embeds = $3 WHERE message_id = $4`,
        [new_content, date, embeds.length > 0 ? JSON.stringify(embeds) : null, message_id],
      );

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  updateAccount: async (account, avatar, username, discriminator, password, new_pw, new_em) => {
    try {
      let new_avatar = account.avatar;
      let new_username = account.username;
      let new_discriminator = account.discriminator;
      let new_email = account.email;
      let new_password = account.password;
      let new_token = account.token;

      if (!password && !new_pw && !new_em) {
        if (avatar != null && avatar.includes('data:image/')) {
          const extension = avatar.split('/')[1].split(';')[0];
          const imgData = avatar.replace(`data:image/${extension};base64,`, '');
          const name = generateString(30);
          const name_hash = md5(name);

          const validExtension = extension === 'jpeg' ? 'jpg' : extension;

          new_avatar = name_hash.toString();

          if (!existsSync(`./www_dynamic/avatars/${account.id}`)) {
            mkdirSync(`./www_dynamic/avatars/${account.id}`, { recursive: true });
          }

          writeFileSync(
            `./www_dynamic/avatars/${account.id}/${name_hash}.${validExtension}`,
            imgData,
            'base64',
          );

          await database.runQuery(`UPDATE users SET avatar = $1 WHERE id = $2`, [
            new_avatar,
            account.id,
          ]);
        } else if (avatar != new_avatar) {
          await database.runQuery(`UPDATE users SET avatar = $1 WHERE id = $2`, [null, account.id]);
        }

        return 3;
      } //avatar change only

      if (new_em != null) {
        new_email = new_em;
      }

      if (new_pw != null) {
        new_password = new_pw;
      }

      if (username != null) {
        new_username = username;
      }

      if (avatar != null && avatar != account.avatar) {
        new_avatar = avatar;
      }

      const usersRows =
        (await database.runQuery(`SELECT COUNT(*) as user_count FROM users WHERE username = $1`, [
          new_username,
        ])) ?? [];

      if (
        usersRows &&
        usersRows.length > 0 &&
        parseInt(usersRows[0].user_count) >= 9998 &&
        account.username != new_username
      ) {
        return 1;
      }

      if (discriminator) {
        const parsedDiscriminator = parseInt(discriminator);

        if (
          isNaN(parsedDiscriminator) ||
          parsedDiscriminator < 1 ||
          parsedDiscriminator > 9999 ||
          discriminator.length !== 4
        ) {
          return 0;
        }

        const existsAlready = await global.database.runQuery(
          `
                    SELECT EXISTS (
                        SELECT 1 FROM users WHERE username = $1 AND discriminator = $2 AND id != $3
                    ) AS does_exist;
                `,
          [new_username, discriminator, account.id],
        );

        if (existsAlready && existsAlready.length > 0 && !existsAlready[0].does_exist) {
          new_discriminator = discriminator;
        } else return 0;
      }

      if (
        (new_email != account.email &&
          new_password != account.password &&
          new_username != account.username &&
          new_discriminator != account.discriminator) ||
        new_email != account.email ||
        new_password != account.password ||
        new_username != account.username ||
        new_discriminator != account.discriminator
      ) {
        if (new_avatar != null && new_avatar.includes('data:image/')) {
          const extension = new_avatar.split('/')[1].split(';')[0];
          const imgData = new_avatar.replace(`data:image/${extension};base64,`, '');
          const name = generateString(30);
          const name_hash = md5(name);

          const validExtension = extension === 'jpeg' ? 'jpg' : extension;

          new_avatar = name_hash.toString();

          if (!existsSync(`./www_dynamic/avatars/${account.id}`)) {
            mkdirSync(`./www_dynamic/avatars/${account.id}`, { recursive: true });
          }

          writeFileSync(
            `./www_dynamic/avatars/${account.id}/${name_hash}.${validExtension}`,
            imgData,
            'base64',
          );
        }

        if (new_pw != null && new_password != account.password) {
          if (account.password) {
            const checkPassword = await database.doesThisMatchPassword(password, account.password);

            if (!checkPassword) {
              return 2; //invalid password
            }
          }

          const salt = await genSalt(10);
          const newPwHash = await hash(new_password, salt);
          const token = generateToken(account.id, newPwHash);

          new_token = token;
          new_password = newPwHash;
        } else {
          const checkPassword = await database.doesThisMatchPassword(password, account.password);

          if (!checkPassword) {
            return 2; //invalid password
          }
        }

        await database.runQuery(
          `UPDATE users SET username = $1, discriminator = $2, email = $3, password = $4, avatar = $5, token = $6 WHERE id = $7`,
          [
            new_username,
            new_discriminator,
            new_email,
            new_password,
            new_avatar,
            new_token,
            account.id,
          ],
        );
      } else if (new_avatar != null && new_avatar.includes('data:image/')) {
        const extension = new_avatar.split('/')[1].split(';')[0];
        const imgData = new_avatar.replace(`data:image/${extension};base64,`, '');
        const name = generateString(30);
        const name_hash = md5(name);

        const validExtension = extension === 'jpeg' ? 'jpg' : extension;

        new_avatar = name_hash.toString();

        if (!existsSync(`./www_dynamic/avatars/${account.id}`)) {
          mkdirSync(`./www_dynamic/avatars/${account.id}`, { recursive: true });
        }

        writeFileSync(
          `./www_dynamic/avatars/${account.id}/${name_hash}.${validExtension}`,
          imgData,
          'base64',
        );

        await database.runQuery(`UPDATE users SET avatar = $1 WHERE id = $2`, [
          new_avatar,
          account.id,
        ]);
      } //check if they changed avatar while entering their pw? (dumbie u dont need to do that)

      return 3; //success
    } catch (error) {
      logText(error, 'error');
      return -1;
    }
  },
  unverifyEmail: async (id) => {
    try {
      await database.runQuery(`UPDATE users SET verified = $1 WHERE id = $2`, [0, id]);

      return true;
    } catch (error) {
      logText(error, 'error');

      return false;
    }
  },
  checkAccount: async (email, password, ip) => {
    try {
      const user = await database.getAccountByEmail(email);

      // IHATE TYPESCRIPT I HATE TYPESCRIPT I HATE TYPESCRIPT
      if (user == null || !user?.email || !user?.password || !user?.token || !user?.settings) {
        return {
          success: false,
          reason: 'Email and/or password is invalid.',
        };
      }

      if (user.disabled_until != null) {
        return {
          success: false,
          disabled_until: user.disabled_until,
        };
      }

      const comparison = compareSync(password, user.password);

      if (!comparison) {
        return {
          success: false,
          reason: 'Email and/or password is invalid.',
        };
      }

      await database.runQuery(`UPDATE users SET last_login_ip = $1 WHERE id = $2`, [ip, user.id]);

      return {
        token: user.token,
      };
    } catch (error) {
      logText(error, 'error');

      return {
        success: false,
        reason: 'Something went wrong while checking account.',
      };
    }
  },
};

export default database;
