import ctx from "../context.ts";

const properties = {
  ignoreDebug: false,
  disabled: false,
  fullErrors: true,
};

const logText = (text: any, type: string) => {
  if (properties.disabled || (type == 'debug' && properties.ignoreDebug)) {
    return;
  }

  if (!ctx.config!.debug_logs) {
    ctx.config!.debug_logs = {
      gateway: true,
      rtc: true,
      media: true,
      udp: true,
      rest: true,
      dispatcher: true,
      mr: true,
      errors: true,
      watchdog: true,
    }; //compatibility
  }

  if (!ctx.config!.debug_logs['errors'] && type === 'error') {
    return;
  }

  if (!ctx.config!.debug_logs['dispatcher'] && type === 'dispatcher') {
    return;
  }

  if (!ctx.config!.debug_logs['watchdog'] && type === 'watchdog') {
    return;
  }

  const restTags = ['oldcord', 'debug', 'emailer'];

  if (!ctx.config!.debug_logs['rest'] && restTags.includes(type.toLowerCase())) {
    return;
  }

  if (type !== 'error') {
    console.log(`[OLDCORDV4] <${type.toUpperCase()}>: ${text}`);
    return;
  }

  if (properties.fullErrors) {
    console.error(text);
    return;
  }

  const stack = text.stack;
  const functionname = stack.split('\n')[1].trim().split(' ')[1] || '<anonymous>';
  const message = text.toString();

  console.error(`[OLDCORDV4] ERROR @ ${functionname} -> ${message}`);
};

export { logText };
