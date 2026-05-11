/**
 * Pure-function helpers shared across TaskFlow MCP tools and exposed for
 * cross-repo Python consumers (actor resolution roundtrip tests).
 */
import { describe, expect, it } from 'bun:test';
import {
  normalizeEngineNotificationEvents,
  parseActorArg,
  parseNotificationEvents,
} from './taskflow-helpers.ts';

describe('parseActorArg', () => {
  it('accepts a valid taskflow_person actor', () => {
    const actor = parseActorArg({
      actor_type: 'taskflow_person',
      source_auth: 'jwt',
      user_id: 'u1',
      board_id: 'b1',
      person_id: 'alice',
      display_name: 'Alice',
    });
    expect(actor.actor_type).toBe('taskflow_person');
    if (actor.actor_type === 'taskflow_person') {
      expect(actor.person_id).toBe('alice');
      expect(actor.display_name).toBe('Alice');
    }
  });

  it('accepts a valid api_service actor', () => {
    const actor = parseActorArg({
      actor_type: 'api_service',
      source_auth: 'api_token',
      board_id: 'b1',
      service_name: 'taskflow-api',
    });
    expect(actor.actor_type).toBe('api_service');
    if (actor.actor_type === 'api_service') {
      expect(actor.service_name).toBe('taskflow-api');
    }
  });

  it('rejects null', () => {
    expect(() => parseActorArg(null)).toThrow('actor: expected object');
  });

  it('rejects unknown actor_type', () => {
    expect(() => parseActorArg({ actor_type: 'unknown' })).toThrow(
      'actor.actor_type: unknown value',
    );
  });

  it('rejects taskflow_person with missing person_id', () => {
    expect(() =>
      parseActorArg({
        actor_type: 'taskflow_person',
        source_auth: 'jwt',
        user_id: 'u1',
        board_id: 'b1',
        display_name: 'Alice',
      }),
    ).toThrow('actor.person_id: required string');
  });

  it('rejects api_service with wrong source_auth', () => {
    expect(() =>
      parseActorArg({
        actor_type: 'api_service',
        source_auth: 'jwt',
        board_id: 'b1',
        service_name: 'taskflow-api',
      }),
    ).toThrow('actor.source_auth: expected "api_token"');
  });
});

describe('parseNotificationEvents', () => {
  it('accepts a valid deferred_notification', () => {
    const result = parseNotificationEvents([
      { kind: 'deferred_notification', target_person_id: 'alice', message: 'Hello' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('deferred_notification');
    if (result[0].kind === 'deferred_notification') {
      expect(result[0].target_person_id).toBe('alice');
      expect(result[0].message).toBe('Hello');
    }
  });

  it('accepts a valid direct_message', () => {
    const result = parseNotificationEvents([
      { kind: 'direct_message', target_chat_jid: 'jid@s.whatsapp.net', message: 'Hi there' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('direct_message');
    if (result[0].kind === 'direct_message') {
      expect(result[0].target_chat_jid).toBe('jid@s.whatsapp.net');
      expect(result[0].message).toBe('Hi there');
    }
  });

  it('accepts a valid parent_notification', () => {
    const result = parseNotificationEvents([
      { kind: 'parent_notification', parent_group_jid: 'group@g.us', message: 'Update' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('parent_notification');
    if (result[0].kind === 'parent_notification') {
      expect(result[0].parent_group_jid).toBe('group@g.us');
      expect(result[0].message).toBe('Update');
    }
  });

  it('rejects items with unknown kind', () => {
    expect(() =>
      parseNotificationEvents([{ kind: 'unknown_kind', message: 'Should fail' }]),
    ).toThrow(/unknown value/);
  });

  it('returns empty array for nullish input and rejects malformed non-array input', () => {
    expect(parseNotificationEvents(null)).toEqual([]);
    expect(parseNotificationEvents(undefined)).toEqual([]);
    expect(() => parseNotificationEvents('a string')).toThrow(/expected array/);
    expect(() => parseNotificationEvents(42)).toThrow(/expected array/);
  });

  it('rejects empty message string', () => {
    expect(() =>
      parseNotificationEvents([
        { kind: 'deferred_notification', target_person_id: 'alice', message: '' },
      ]),
    ).toThrow(/message/);
    expect(() =>
      parseNotificationEvents([
        { kind: 'direct_message', target_chat_jid: 'jid@s.whatsapp.net', message: '' },
      ]),
    ).toThrow(/message/);
    expect(() =>
      parseNotificationEvents([
        { kind: 'parent_notification', parent_group_jid: 'group@g.us', message: '' },
      ]),
    ).toThrow(/message/);
  });

  it('rejects deferred_notification missing required field target_person_id', () => {
    expect(() =>
      parseNotificationEvents([{ kind: 'deferred_notification', message: 'No person' }]),
    ).toThrow(/target_person_id/);
  });

  it('accepts destination_message — symbolic-name routing for cross-board approval flows (A12)', () => {
    // The agent's send_message MCP tool resolves the destination_name via
    // agent_destinations. The engine emits this kind for cross-board
    // approval forwarding where it cannot know the receiving agent's
    // local destination names ahead of time.
    const result = parseNotificationEvents([
      { kind: 'destination_message', destination_name: 'parent_board', message: 'Request' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('destination_message');
    if (result[0].kind === 'destination_message') {
      expect(result[0].destination_name).toBe('parent_board');
      expect(result[0].message).toBe('Request');
    }
  });

  it('rejects destination_message missing required destination_name (A12)', () => {
    expect(() =>
      parseNotificationEvents([{ kind: 'destination_message', message: 'No destination' }]),
    ).toThrow(/destination_name/);
  });
});

describe('normalizeEngineNotificationEvents', () => {
  it('normalizes group-routed, deferred, and parent notifications', () => {
    const result = normalizeEngineNotificationEvents({
      notifications: [
        {
          notification_group_jid: 'group-1@g.us',
          target_person_id: 'alice',
          message: 'group update',
        },
        { target_person_id: 'bob', message: 'deferred update' },
      ],
      parent_notification: { parent_group_jid: 'parent@g.us', message: 'parent update' },
    });

    expect(result).toEqual([
      { kind: 'direct_message', target_chat_jid: 'group-1@g.us', message: 'group update' },
      { kind: 'deferred_notification', target_person_id: 'bob', message: 'deferred update' },
      { kind: 'parent_notification', parent_group_jid: 'parent@g.us', message: 'parent update' },
    ]);
  });

  it('preserves same-call parent dedup behavior', () => {
    const result = normalizeEngineNotificationEvents({
      notifications: [
        {
          notification_group_jid: 'parent@g.us',
          target_person_id: 'alice',
          message: 'already delivered',
        },
      ],
      parent_notification: { parent_group_jid: 'parent@g.us', message: 'duplicate parent update' },
    });

    expect(result).toEqual([
      { kind: 'direct_message', target_chat_jid: 'parent@g.us', message: 'already delivered' },
    ]);
  });

  it('rejects malformed engine notification entries', () => {
    expect(() =>
      normalizeEngineNotificationEvents({ notifications: [{ message: 'missing route' }] }),
    ).toThrow(/missing routing target/);
  });

  it('normalizes engine destination_name into destination_message kind (A12 cross-board approval)', () => {
    // Engine emits { destination_name, message } in notifications when it
    // wants the receiving agent to resolve the destination by name via its
    // own agent_destinations registry (rather than passing a JID directly).
    const result = normalizeEngineNotificationEvents({
      notifications: [
        { destination_name: 'source-CHI', message: '✅ Solicitação aprovada' },
      ],
    });
    expect(result).toEqual([
      { kind: 'destination_message', destination_name: 'source-CHI', message: '✅ Solicitação aprovada' },
    ]);
  });

  it('routes target_kind=dm via target_chat_jid', () => {
    const result = normalizeEngineNotificationEvents({
      notifications: [
        {
          target_kind: 'dm',
          target_chat_jid: 'alice@s.whatsapp.net',
          message: 'dm-routed',
        },
      ],
    });
    expect(result).toEqual([
      { kind: 'direct_message', target_chat_jid: 'alice@s.whatsapp.net', message: 'dm-routed' },
    ]);
  });
});
