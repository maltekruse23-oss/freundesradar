// FreundesRadar: holt WoW-Forever-Charaktere per Vor- und Nachname von der Blizzard-API,
// speichert sie und schreibt die Chronik (Stufen, Beute, Erfolge).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const LOCALE = { eu: 'de_DE', us: 'en_US' } as const;
const LOOT = new Set(['RARE', 'EPIC', 'LEGENDARY', 'ARTIFACT']);
type Region = 'eu' | 'us';
// deno-lint-ignore no-explicit-any
type J = any;

class UserError extends Error {}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------- Blizzard ----------
let tok: { value: string; exp: number } | null = null;
async function token(): Promise<string> {
  if (tok && tok.exp > Date.now() + 60_000) return tok.value;
  const id = Deno.env.get('BNET_CLIENT_ID'), secret = Deno.env.get('BNET_CLIENT_SECRET');
  if (!id || !secret) throw new UserError('Die Blizzard-Zugangsdaten fehlen noch. Der Seitenbetreiber muss sie einmal in Supabase eintragen.');
  const r = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${id}:${secret}`), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`Blizzard-Login fehlgeschlagen (${r.status})`);
  const j = await r.json();
  tok = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tok.value;
}

async function bnet(region: Region, path: string, ns: 'profile' | 'static' = 'profile'): Promise<J | null> {
  const url = `https://${region}.api.blizzard.com${path}${path.includes('?') ? '&' : '?'}namespace=${ns}-forever-${region}&locale=${LOCALE[region]}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
  if (r.status === 404) { await r.body?.cancel(); return null; }
  if (r.status === 401) tok = null;
  if (!r.ok) { await r.body?.cancel(); throw new Error(`Blizzard ${r.status} bei ${path}`); }
  return await r.json();
}
const sub = (m: J, part: string) => bnet(m.region, `/profile/wow/character/${encodeURIComponent(m.slug)}/${part}`).catch(() => null);

// ---------- Eingaben ----------
const cap = (s: string) => s[0].toLocaleUpperCase('de') + s.slice(1).toLocaleLowerCase('de');
function charSlug(input: string) {
  const parts = input.normalize('NFC').trim().split(/[\s-]+/).filter(Boolean);
  if (!parts.length || parts.length > 2 || parts.some((p) => !/^\p{L}{2,24}$/u.test(p))) {
    throw new UserError('Bitte Vor- und Nachnamen des Charakters eingeben, zum Beispiel „Daxan Windfury“.');
  }
  return { slug: parts.join('-').toLocaleLowerCase('de'), name: cap(parts[0]), surname: parts[1] ? cap(parts[1]) : null };
}
function guildSlug(input: string) {
  const s = input.normalize('NFC').trim().toLocaleLowerCase('de').replace(/['’`]/g, '').replace(/\s+/g, '-');
  if (!/^[\p{L}\p{N}-]{2,48}$/u.test(s)) throw new UserError('Bitte den Gildennamen genau wie im Spiel eingeben.');
  return s;
}
async function checkCode(code: unknown) {
  const { data } = await sb.from('fr_config').select('value').eq('key', 'invite').single();
  if (typeof code !== 'string' || code.trim().toLowerCase() !== data?.value) {
    throw new UserError('Der Gruppencode stimmt nicht. Frag den, der dir den Link geschickt hat.');
  }
}

// ---------- Umwandeln ----------
function tooltip(i: J) {
  const L: J[] = [];
  const add = (t: unknown, c?: string | null, r?: unknown) => { if (t) L.push({ t, ...(c ? { c } : {}), ...(r ? { r } : {}) }); };
  add(i.level?.display_string, 'gold');
  add(i.binding?.name);
  add(i.inventory_type?.name, null, i.item_subclass?.name);
  if (i.weapon) { add(i.weapon.damage?.display_string, null, i.weapon.attack_speed?.display_string); add(i.weapon.dps?.display_string); }
  add(i.armor?.display?.display_string);
  for (const s of i.stats ?? []) {
    const c = s.display?.color;
    add(s.display?.display_string, s.is_negated ? 'grey' : c && c.g > 200 && c.r < 100 ? 'green' : null);
  }
  for (const e of i.enchantments ?? []) add(e.display_string, 'green');
  for (const s of i.spells ?? []) add(s.description, 'green');
  add(i.durability?.display_string);
  add(i.requirements?.level?.display_string);
  add(i.requirements?.playable_classes?.display_string);
  add(i.set?.display_string, 'gold');
  if (i.description) add(`„${i.description}“`, 'gold');
  const p = i.sell_price?.display_strings;
  if (p) L.push({ t: p.header, money: [p.gold, p.silver, p.copper] });
  return L;
}

async function equipment(region: Region, eq: J) {
  const items: J[] = eq?.equipped_items ?? [];
  const ids = [...new Set(items.map((i) => i.media?.id).filter(Boolean))] as number[];
  const { data: cached } = await sb.from('fr_icons').select('media_id,icon').in('media_id', ids.length ? ids : [0]);
  const icons = new Map((cached ?? []).map((c: J) => [c.media_id, c.icon]));
  await Promise.all(ids.filter((id) => !icons.has(id)).map(async (id) => {
    const m = await bnet(region, `/data/wow/media/item/${id}`, 'static').catch(() => null);
    const url = m?.assets?.find((a: J) => a.key === 'icon')?.value;
    if (url) { icons.set(id, url); await sb.from('fr_icons').upsert({ media_id: id, icon: url }); }
  }));
  return items.map((i) => ({
    slot: i.slot?.type, name: i.name, id: i.item?.id, quality: i.quality?.type ?? 'COMMON',
    icon: icons.get(i.media?.id) ?? null, ilvl: i.level?.value ?? null, lines: tooltip(i),
  }));
}

function professions(p: J) {
  const one = (e: J) => ({
    name: e.profession?.name,
    skill: e.skill_points ?? e.tiers?.[0]?.skill_points ?? null,
    max: e.max_skill_points ?? e.tiers?.[0]?.max_skill_points ?? null,
  });
  return { primary: (p?.primaries ?? []).map(one).filter((x: J) => x.name), secondary: (p?.secondaries ?? []).map(one).filter((x: J) => x.name) };
}

function stats(s: J) {
  const e = (o: J) => o?.effective ?? o?.value ?? null;
  return {
    health: s.health ?? null, power: s.power ?? null, powerType: s.power_type?.name ?? null,
    str: e(s.strength), agi: e(s.agility), sta: e(s.stamina), int: e(s.intellect), spi: e(s.spirit), armor: e(s.armor),
  };
}

function achievements(a: J) {
  const done = (a?.achievements ?? []).filter((x: J) => x.completed_timestamp)
    .map((x: J) => ({ name: x.achievement?.name, at: x.completed_timestamp })).sort((p: J, q: J) => q.at - p.at);
  return { points: a?.total_points ?? null, count: done.length, recent: done.slice(0, 10) };
}
const asset = (m: J, k: string) => m?.assets?.find((a: J) => a.key === k)?.value ?? null;
// Postgres liefert "+00:00", JavaScript "Z": deshalb als Zeitpunkt vergleichen, nicht als Text
const same = (a: string | null, b: string | null) => (a && b ? Date.parse(a) === Date.parse(b) : a === b);

// ---------- Aktualisieren ----------
async function refreshMember(m: J): Promise<string> {
  const now = new Date().toISOString();
  const p = await bnet(m.region, `/profile/wow/character/${encodeURIComponent(m.slug)}`);
  if (!p) { await sb.from('fr_members').update({ checked_at: now }).eq('id', m.id); return m.state; }

  const lastLogin = p.last_login_timestamp ? new Date(p.last_login_timestamp).toISOString() : null;
  const when = lastLogin ?? now;
  const wasOk = m.state === 'ok';
  const upd: J = {
    state: 'ok', checked_at: now, bnet_id: p.id, name: p.name ?? m.name, surname: p.surname ?? m.surname, level: p.level,
    class_id: p.character_class?.id ?? null, class_name: p.character_class?.name ?? null,
    race_id: p.race?.id ?? null, race_name: p.race?.name ?? null, faction: p.faction?.type ?? null,
    spec_name: p.active_spec?.name ?? null, guild_name: p.guild?.name ?? null, guild_slug: p.guild?.slug ?? null,
    ruleset: p.ruleset?.name ?? null, ilvl: p.equipped_item_level ?? p.average_item_level ?? null,
    achievement_points: p.achievement_points ?? null, last_login: lastLogin,
  };
  const feed: J[] = [];
  if (!wasOk) feed.push({ kind: 'join', level: p.level, at: now });
  else {
    if (p.level > (m.level ?? 0)) feed.push({ kind: 'level', level: p.level, at: when });
    if (lastLogin && m.last_login && !same(lastLogin, m.last_login)) feed.push({ kind: 'seen', level: p.level, at: when });
    if (p.guild?.name && p.guild.name !== m.guild_name) feed.push({ kind: 'guild', title: p.guild.name, level: p.level, at: when });
  }

  // Unterseiten nur laden, wenn sich der Charakter seit dem letzten Mal abgemeldet hat
  if (!wasOk || !same(lastLogin, m.last_login) || !m.equipment) {
    const [eq, media, prof, st, ach] = await Promise.all([
      sub(m, 'equipment'), sub(m, 'character-media'), sub(m, 'professions'), sub(m, 'statistics'), sub(m, 'achievements'),
    ]);
    if (eq) {
      upd.equipment = await equipment(m.region, eq);
      if (wasOk && m.equipment) {
        const old = new Set((m.equipment as J[]).map((x) => x.id));
        for (const it of upd.equipment) {
          if (LOOT.has(it.quality) && !old.has(it.id)) feed.push({ kind: 'item', title: it.name, quality: it.quality, icon: it.icon, level: p.level, at: when });
        }
      }
    }
    if (media) Object.assign(upd, { avatar_url: asset(media, 'avatar'), inset_url: asset(media, 'inset'), main_url: asset(media, 'main-raw') ?? asset(media, 'main') });
    if (prof) upd.professions = professions(prof);
    if (st) upd.stats = stats(st);
    if (ach) {
      upd.achievements = achievements(ach);
      const seen = m.achievements?.recent?.[0]?.at ?? 0;
      if (wasOk) for (const a of upd.achievements.recent) if (a.at > seen) feed.push({ kind: 'achievement', title: a.name, level: p.level, at: new Date(a.at).toISOString() });
    }
  }

  const { error } = await sb.from('fr_members').update(upd).eq('id', m.id);
  if (error) throw error;
  if (feed.length) await sb.from('fr_feed').insert(feed.map((f) => ({ member_id: m.id, ...f })));
  await sb.from('fr_levels').upsert({ member_id: m.id, level: p.level, at: wasOk ? when : now }, { onConflict: 'member_id,level', ignoreDuplicates: true });
  return 'ok';
}

// Gildenliste: auch Mitglieder unter Stufe 10, die noch kein eigenes Profil haben
async function syncGuild(g: J): Promise<number> {
  const now = new Date().toISOString();
  const roster = await bnet(g.region, `/data/wow/guild/${encodeURIComponent(g.slug)}/roster`);
  await sb.from('fr_guilds').update({ checked_at: now, member_count: roster?.members?.length ?? g.member_count }).eq('id', g.id);
  if (!roster) return 0;
  const chars: J[] = (roster.members ?? []).map((x: J) => x.character).filter((c: J) => c?.slug);
  const rows = chars.map((c) => ({
    region: g.region, slug: c.slug, name: c.name, surname: c.surname ?? null, state: 'roster', source: 'guild',
    level: c.level ?? null, class_id: c.playable_class?.id ?? null, race_id: c.playable_race?.id ?? null,
    faction: c.faction?.type ?? null, guild_name: g.name, guild_slug: g.slug,
  }));
  if (rows.length) await sb.from('fr_members').upsert(rows, { onConflict: 'region,slug', ignoreDuplicates: true });
  // Stufen der Mitglieder ohne eigenes Profil aus der Gildenliste nachziehen
  const { data: low } = await sb.from('fr_members').select('id,slug,level').eq('region', g.region).neq('state', 'ok').in('slug', chars.map((c) => c.slug));
  const bySlug = new Map(chars.map((c) => [c.slug, c]));
  for (const m of low ?? []) {
    const lvl = bySlug.get(m.slug)?.level;
    if (!lvl || lvl === m.level) continue;
    await sb.from('fr_members').update({ level: lvl, state: 'roster' }).eq('id', m.id);
    await sb.from('fr_levels').upsert({ member_id: m.id, level: lvl, at: now }, { onConflict: 'member_id,level', ignoreDuplicates: true });
    if (m.level && lvl > m.level) await sb.from('fr_feed').insert({ member_id: m.id, kind: 'level', level: lvl, at: now });
  }
  return rows.length;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<unknown>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()!); }));
}

async function refreshAll() {
  const { data: locked } = await sb.rpc('fr_try_lock');
  if (!locked) return { ok: true, skipped: true };
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const { data: guilds } = await sb.from('fr_guilds').select('*').or(`checked_at.is.null,checked_at.lt.${ago(25)}`);
  for (const g of guilds ?? []) await syncGuild(g).catch((e) => console.error('guild', g.slug, e));
  const { data: members } = await sb.from('fr_members').select('*')
    .or(`checked_at.is.null,checked_at.lt.${ago(4)}`).order('checked_at', { ascending: true, nullsFirst: true }).limit(60);
  let n = 0;
  await pool(members ?? [], 6, async (m: J) => { await refreshMember(m).catch((e) => console.error('char', m.slug, e)); n++; });
  return { ok: true, refreshed: n };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body: J = await req.json().catch(() => ({}));
    const region: Region = body.region === 'us' ? 'us' : 'eu';
    if (body.action === 'add') {
      await checkCode(body.code);
      const c = charSlug(String(body.name ?? ''));
      let { data: m } = await sb.from('fr_members').select('*').eq('region', region).eq('slug', c.slug).maybeSingle();
      if (!m) {
        const ins = await sb.from('fr_members').insert({ region, slug: c.slug, name: c.name, surname: c.surname }).select().single();
        if (ins.error) throw ins.error;
        m = ins.data;
      }
      const state = await refreshMember(m);
      return json({ ok: true, id: m.id, state });
    }
    if (body.action === 'addGuild') {
      await checkCode(body.code);
      const slug = guildSlug(String(body.name ?? ''));
      const info = await bnet(region, `/data/wow/guild/${encodeURIComponent(slug)}`);
      if (!info) throw new UserError('Diese Gilde findet Blizzard nicht. Ist der Name genau wie im Spiel geschrieben?');
      const { data: g, error } = await sb.from('fr_guilds')
        .upsert({ region, slug, name: info.name, faction: info.faction?.type ?? null, member_count: info.member_count ?? null }, { onConflict: 'region,slug' })
        .select().single();
      if (error) throw error;
      const n = await syncGuild(g);
      // Profile der neuen Mitglieder im Hintergrund holen, nachdem die Antwort raus ist
      const bg = refreshAll().catch(console.error);
      (globalThis as J).EdgeRuntime?.waitUntil?.(bg);
      return json({ ok: true, guild: info.name, members: n });
    }
    if (body.action === 'remove') {
      await checkCode(body.code);
      await sb.from('fr_members').delete().eq('id', Number(body.id));
      return json({ ok: true });
    }
    return json(await refreshAll());
  } catch (e) {
    if (e instanceof UserError) return json({ ok: false, error: e.message }, 400);
    console.error(e);
    return json({ ok: false, error: 'Blizzard antwortet gerade nicht richtig. Versuch es in einer Minute nochmal.' }, 500);
  }
});
