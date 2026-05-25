import type { Acl } from '../config/acl.js';
import { logger } from '../logger.js';
import type { InboundEvent } from '../slack/types.js';

export interface AclResult {
  allowed: boolean;
  reason?: string;
}

export function checkAcl(acl: Acl, evt: InboundEvent): AclResult {
  if (acl.users.deny.includes(evt.user_id)) {
    return { allowed: false, reason: 'user_denied' };
  }

  if (acl.channels.deny.includes(evt.channel_id)) {
    return { allowed: false, reason: 'channel_denied' };
  }

  const channelMatches =
    acl.channels.allow.includes('*') || acl.channels.allow.includes(evt.channel_id);
  if (!channelMatches) {
    return { allowed: false, reason: 'channel_not_in_allowlist' };
  }

  if (!acl.event_kinds.enabled.includes(evt.kind)) {
    return { allowed: false, reason: 'event_kind_disabled' };
  }

  return { allowed: true };
}

export function logDenial(evt: InboundEvent, result: AclResult): void {
  logger.info(
    {
      event_id: evt.event_id,
      user_id: evt.user_id,
      channel_id: evt.channel_id,
      kind: evt.kind,
      reason: result.reason,
    },
    'acl_denied',
  );
}
