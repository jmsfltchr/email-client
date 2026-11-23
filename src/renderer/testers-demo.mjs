// Demo stand-in for the Notion database behind the Testers tab. Nothing leaves the machine.

import { linkFromInput } from '../core/notion.mjs';

const schema = {
  title: 'Name',
  links: 'Conversation links',
  fields: [
    { name: 'Tags', type: 'multi_select', options: [{ name: 'power user', color: 'green' }, { name: 'iOS', color: 'blue' }, { name: 'Android', color: 'orange' }, { name: 'found a bug', color: 'red' }, { name: 'design partner', color: 'purple' }] },
    { name: 'Stage', type: 'select', options: [{ name: 'Invited', color: 'gray' }, { name: 'Onboarded', color: 'yellow' }, { name: 'Active', color: 'green' }, { name: 'Gone quiet', color: 'brown' }] },
    { name: 'Interviewed', type: 'checkbox', options: [] },
    { name: 'Notes', type: 'rich_text', options: [] },
  ],
};

const person = (id, name, tags, stage, interviewed, notes, links) => ({
  id, url: `https://www.notion.so/${id}`, name, edited: Date.now(),
  values: { Tags: tags, Stage: stage, Interviewed: interviewed, Notes: notes },
  links: links.map(([input, label]) => linkFromInput(input, label)),
});

export function createDemoNotion() {
  const rows = [
    person('demo-1', 'Priya Raman', ['power user', 'iOS'], 'Active', true, 'Wants keyboard shortcuts everywhere. Happy to do a second call.', [
      ['https://app.slack.com/client/T0FERNHILL/D0PRIYA', 'DM'], ['priya@fernhill.example', 'work'], ['https://www.instagram.com/direct/t/1000001', '']]),
    person('demo-2', 'Marcus Oyelaran', ['found a bug', 'Android'], 'Active', false, 'Sync stalls on hotel wifi. Sent logs on Discord.', [
      ['https://discord.com/channels/@me/200000000000000001', 'DM'], ['https://discord.com/channels/300000000000000001/300000000000000002', '#alpha-feedback'], ['marcus.oyelaran@brightwater.example', '']]),
    person('demo-3', 'Dana Whitfield', ['design partner'], 'Onboarded', true, '', [
      ['https://teams.microsoft.com/l/chat/0/0?users=dana@whitfield-law.example', 'chat'], ['dana@whitfield-law.example', '']]),
    person('demo-4', 'Tomás Lindqvist', [], 'Invited', false, 'Met at the meetup; prefers Instagram.', [
      ['https://www.instagram.com/direct/t/1000002', '']]),
  ];
  let n = 0;
  const copy = (r) => JSON.parse(JSON.stringify(r));
  const find = (id) => rows.find((r) => r.id === id);
  const trash = new Map();
  return {
    async notionStatus() { return { connected: true, title: 'Alpha testers (demo)', url: 'https://www.notion.so/' }; },
    async notionConnect() { throw new Error('Not available in demo mode'); },
    async notionDisconnect() { throw new Error('Not available in demo mode'); },
    async notionLoad() { return { schema: copy(schema), rows: copy(rows) }; },
    async notionCreate(patch) {
      const r = { id: `demo-new-${++n}`, url: 'https://www.notion.so/', name: patch.name || '', links: [], edited: Date.now(), values: { Tags: [], Stage: '', Interviewed: false, Notes: '' } };
      rows.push(r);
      return copy(r);
    },
    async notionUpdate(id, patch) {
      const r = find(id);
      if (!r) throw new Error('That person is no longer in the database.');
      if (patch.name !== undefined) r.name = patch.name;
      if (patch.links !== undefined) r.links = copy(patch.links);
      Object.assign(r.values, copy(patch.values || {}));
      for (const f of schema.fields) {
        for (const name of [].concat(r.values[f.name] || []).filter((v) => typeof v === 'string' && f.type.endsWith('select'))) {
          if (!f.options.some((o) => o.name === name)) f.options.push({ name, color: 'default' });
        }
      }
      r.edited = Date.now();
      return copy(r);
    },
    async notionTrash(id, trashed = true) {
      if (trashed) { const i = rows.findIndex((r) => r.id === id); if (i >= 0) trash.set(id, rows.splice(i, 1)[0]); }
      else if (trash.has(id)) { rows.push(trash.get(id)); trash.delete(id); }
      return true;
    },
  };
}
