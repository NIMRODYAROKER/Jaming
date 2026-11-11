// Jaming — Cloudflare Worker + SQLite Durable Object
// The website files live in /public. Everything under /api/* is handled here.

import { DurableObject } from 'cloudflare:workers';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.DB.get(env.DB.idFromName('main'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

const COLORS = ['#FF5A1F', '#2F6BFF', '#12A26B', '#C2399B', '#E8A500', '#7A4DFF', '#00A3B4', '#D9363E', '#5B8C00', '#B5651D'];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

function randomId(bytes = 9) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function toHex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function hashPassword(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return toHex(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- song links ----------
function parseYT(s) {
  const m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/|v\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function parseSP(s) {
  const m = s.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]{10,})/);
  return m ? 'https://open.spotify.com/track/' + m[1] : null;
}
function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[\(\[][^\)\]]*(official|video|audio|lyric|lyrics|visualizer|קליפ|רשמי|מילים|prod)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s{2,}/g, ' ').trim();
}
const cleanArtist = (a) => String(a || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
async function oembed(url) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 Jaming' } });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
export async function resolveSong(raw, lookup = oembed) {
  raw = String(raw || '').trim().slice(0, 300);
  if (!raw) bad('צריך לכתוב שיר או להדביק קישור');
  const s = { title: '', artist: '', yt: null, sp: null, thumb: null, q: null };
  const yt = parseYT(raw), sp = parseSP(raw);
  if (yt) {
    s.yt = yt; s.thumb = `https://i.ytimg.com/vi/${yt}/mqdefault.jpg`;
    const m = await lookup('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + yt));
    if (m) { s.title = cleanTitle(m.title); s.artist = cleanArtist(m.author_name); }
    if (!s.title) s.title = 'שיר מיוטיוב';
  } else if (sp) {
    s.sp = sp;
    const m = await lookup('https://open.spotify.com/oembed?url=' + encodeURIComponent(sp));
    if (m) { s.title = m.title || ''; s.thumb = m.thumbnail_url || null; }
    if (!s.title) s.title = 'שיר מספוטיפיי';
  } else if (/^https?:\/\//i.test(raw)) {
    bad('הקישור הזה לא נתמך. הדבק קישור מיוטיוב או מספוטיפיי, או כתוב שם של שיר');
  } else {
    s.q = raw; s.title = raw;
  }
  return s;
}

// ---------- the database ----------
export class MixtapeDB extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.lookup = oembed;
    this.migrate();
  }

  q(query, ...binds) { return this.sql.exec(query, ...binds).toArray(); }
  one(query, ...binds) { return this.q(query, ...binds)[0] || null; }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display TEXT NOT NULL,
        pass_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        color TEXT NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS friendships (
        a INTEGER NOT NULL, b INTEGER NOT NULL,
        requester INTEGER NOT NULL,
        status TEXT NOT NULL,
        created INTEGER NOT NULL,
        PRIMARY KEY (a, b)
      );
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner INTEGER NOT NULL,
        per INTEGER NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        group_id TEXT NOT NULL, user_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        invited_by INTEGER,
        created INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS songs (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        artist TEXT,
        yt TEXT, sp TEXT, thumb TEXT, q TEXT,
        created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS songs_group ON songs(group_id);
      CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
    `);
  }

  async fetch(request) {
    try {
      return await this.handle(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      return json({ error: 'משהו נכשל בשרת. נסה שוב' }, 500);
    }
  }

  // ---------- helpers ----------
  pubUser(u) { return u ? { id: u.id, username: u.username, display: u.display, color: u.color } : null; }
  auth(request) {
    const h = request.headers.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) throw new HttpError(401, 'צריך להתחבר');
    const row = this.one('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', token);
    if (!row) throw new HttpError(401, 'צריך להתחבר');
    return row;
  }
  pair(x, y) { return x < y ? [x, y] : [y, x]; }
  friendship(x, y) { const [a, b] = this.pair(x, y); return this.one('SELECT * FROM friendships WHERE a = ? AND b = ?', a, b); }
  areFriends(x, y) { const f = this.friendship(x, y); return !!f && f.status === 'accepted'; }
  membership(gid, uid) { return this.one('SELECT * FROM members WHERE group_id = ? AND user_id = ?', gid, uid); }
  needJoined(gid, uid) {
    const m = this.membership(gid, uid);
    if (!m || m.status !== 'joined') throw new HttpError(403, 'אתה לא בקבוצה הזאת');
    return m;
  }
  async newSession(userId) {
    const token = randomId(24);
    this.sql.exec('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)', token, userId, Date.now());
    return token;
  }

  async handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method;
    let body = {};
    if (method === 'POST' || method === 'PATCH') {
      try { body = await request.json(); } catch (e) { body = {}; }
    }
    let m;

    // ----- accounts -----
    if (path === '/api/signup' && method === 'POST') {
      const username = String(body.username || '').trim();
      const display = String(body.display || '').trim().slice(0, 24);
      const password = String(body.password || '');
      if (!/^[A-Za-z0-9_.]{3,20}$/.test(username)) bad('שם משתמש: 3 עד 20 אותיות באנגלית, מספרים, נקודה או קו תחתון');
      if (!display) bad('צריך לכתוב שם');
      if (password.length < 6) bad('סיסמה צריכה לפחות 6 תווים');
      if (this.one('SELECT id FROM users WHERE username = ?', username)) bad('שם המשתמש הזה תפוס. נסה אחר');
      const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await hashPassword(password, salt);
      const count = this.one('SELECT COUNT(*) AS c FROM users').c;
      const color = COLORS[count % COLORS.length];
      this.sql.exec('INSERT INTO users (username, display, pass_hash, salt, color, created) VALUES (?, ?, ?, ?, ?, ?)',
        username, display, hash, salt, color, Date.now());
      const u = this.one('SELECT * FROM users WHERE username = ?', username);
      return json({ token: await this.newSession(u.id), me: this.pubUser(u) });
    }
    if (path === '/api/login' && method === 'POST') {
      const u = this.one('SELECT * FROM users WHERE username = ?', String(body.username || '').trim());
      if (!u) bad('שם משתמש או סיסמה לא נכונים');
      const hash = await hashPassword(String(body.password || ''), u.salt);
      if (!safeEqual(hash, u.pass_hash)) bad('שם משתמש או סיסמה לא נכונים');
      return json({ token: await this.newSession(u.id), me: this.pubUser(u) });
    }

    const me = this.auth(request);

    if (path === '/api/logout' && method === 'POST') {
      const token = (request.headers.get('authorization') || '').slice(7);
      this.sql.exec('DELETE FROM sessions WHERE token = ?', token);
      return json({ ok: true });
    }
    if (path === '/api/profile' && method === 'POST') {
      const display = String(body.display || '').trim().slice(0, 24);
      if (!display) bad('צריך לכתוב שם');
      this.sql.exec('UPDATE users SET display = ? WHERE id = ?', display, me.id);
      return json({ ok: true });
    }

    // Everything the home screen needs, in one call
    if (path === '/api/home' && method === 'GET') return json(this.home(me));

    // ----- friends -----
    if (path === '/api/users/search' && method === 'GET') {
      const term = (url.searchParams.get('q') || '').trim().replace(/^@/, '');
      if (term.length < 2) return json({ users: [] });
      const like = '%' + term.replace(/[%_]/g, '') + '%';
      const rows = this.q('SELECT * FROM users WHERE id != ? AND (username LIKE ? OR display LIKE ?) ORDER BY (username = ? COLLATE NOCASE) DESC, username LIMIT 12',
        me.id, like, like, term);
      return json({ users: rows.map(u => ({ ...this.pubUser(u), rel: this.relation(me.id, u.id) })) });
    }
    if (path === '/api/friends/request' && method === 'POST') {
      const other = body.userId ? this.one('SELECT * FROM users WHERE id = ?', +body.userId)
                                : this.one('SELECT * FROM users WHERE username = ?', String(body.username || '').trim().replace(/^@/, ''));
      if (!other) bad('לא מצאנו משתמש כזה');
      if (other.id === me.id) bad('זה אתה');
      const f = this.friendship(me.id, other.id);
      const [a, b] = this.pair(me.id, other.id);
      if (f && f.status === 'accepted') return json({ ok: true, rel: 'friends' });
      if (f && f.status === 'pending' && f.requester !== me.id) {
        // they already asked me: accept
        this.sql.exec("UPDATE friendships SET status = 'accepted' WHERE a = ? AND b = ?", a, b);
        return json({ ok: true, rel: 'friends' });
      }
      if (!f) this.sql.exec("INSERT INTO friendships (a, b, requester, status, created) VALUES (?, ?, ?, 'pending', ?)", a, b, me.id, Date.now());
      return json({ ok: true, rel: 'sent' });
    }
    if (path === '/api/friends/accept' && method === 'POST') {
      const f = this.friendship(me.id, +body.userId);
      if (!f || f.status !== 'pending' || f.requester === me.id) bad('אין בקשה כזאת');
      this.sql.exec("UPDATE friendships SET status = 'accepted' WHERE a = ? AND b = ?", f.a, f.b);
      return json({ ok: true });
    }
    if (path === '/api/friends/remove' && method === 'POST') {
      // decline a request, cancel my request, or remove a friend
      const [a, b] = this.pair(me.id, +body.userId);
      this.sql.exec('DELETE FROM friendships WHERE a = ? AND b = ?', a, b);
      return json({ ok: true });
    }

    // ----- groups -----
    if (path === '/api/groups' && method === 'POST') {
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) bad('צריך לתת שם לקבוצה');
      const per = Math.min(10, Math.max(1, parseInt(body.per, 10) || 1));
      const id = randomId(8);
      const now = Date.now();
      this.sql.exec('INSERT INTO groups (id, name, owner, per, created) VALUES (?, ?, ?, ?, ?)', id, name, me.id, per, now);
      this.sql.exec("INSERT INTO members (group_id, user_id, status, invited_by, created) VALUES (?, ?, 'joined', NULL, ?)", id, me.id, now);
      this.invite(id, me, body.invite);
      return json({ id });
    }
    if ((m = path.match(/^\/api\/groups\/([A-Za-z0-9_-]+)$/)) && method === 'GET') {
      return json(this.groupView(m[1], me));
    }
    if ((m = path.match(/^\/api\/groups\/([A-Za-z0-9_-]+)\/invite$/)) && method === 'POST') {
      this.needJoined(m[1], me.id);
      const n = this.invite(m[1], me, body.userIds);
      return json({ ok: true, invited: n });
    }
    if ((m = path.match(/^\/api\/groups\/([A-Za-z0-9_-]+)\/(accept|decline|leave)$/)) && method === 'POST') {
      const gid = m[1], act = m[2];
      const mem = this.membership(gid, me.id);
      if (!mem) bad('אין לך הזמנה לקבוצה הזאת');
      if (act === 'accept') {
        this.sql.exec("UPDATE members SET status = 'joined' WHERE group_id = ? AND user_id = ?", gid, me.id);
      } else {
        this.sql.exec('DELETE FROM members WHERE group_id = ? AND user_id = ?', gid, me.id);
        if (act === 'leave') this.sql.exec('DELETE FROM songs WHERE group_id = ? AND user_id = ?', gid, me.id);
        const left = this.one("SELECT COUNT(*) AS c FROM members WHERE group_id = ? AND status = 'joined'", gid).c;
        if (left === 0) {
          this.sql.exec('DELETE FROM members WHERE group_id = ?', gid);
          this.sql.exec('DELETE FROM songs WHERE group_id = ?', gid);
          this.sql.exec('DELETE FROM groups WHERE id = ?', gid);
        } else {
          const g = this.one('SELECT * FROM groups WHERE id = ?', gid);
          if (g && g.owner === me.id) {
            const next = this.one("SELECT user_id FROM members WHERE group_id = ? AND status = 'joined' ORDER BY created LIMIT 1", gid);
            if (next) this.sql.exec('UPDATE groups SET owner = ? WHERE id = ?', next.user_id, gid);
          }
        }
      }
      return json({ ok: true });
    }
    if ((m = path.match(/^\/api\/groups\/([A-Za-z0-9_-]+)\/songs$/)) && method === 'POST') {
      const gid = m[1];
      this.needJoined(gid, me.id);
      const g = this.one('SELECT * FROM groups WHERE id = ?', gid);
      const mine = this.one('SELECT COUNT(*) AS c FROM songs WHERE group_id = ? AND user_id = ?', gid, me.id).c;
      if (mine >= g.per) bad('כבר הוספת את כל השירים שלך');
      const s = await resolveSong(body.input, this.lookup);
      // re-check after the await, in case of a double tap
      const again = this.one('SELECT COUNT(*) AS c FROM songs WHERE group_id = ? AND user_id = ?', gid, me.id).c;
      if (again >= g.per) bad('כבר הוספת את כל השירים שלך');
      this.sql.exec('INSERT INTO songs (id, group_id, user_id, title, artist, yt, sp, thumb, q, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        randomId(8), gid, me.id, s.title, s.artist, s.yt, s.sp, s.thumb, s.q, Date.now());
      return json({ ok: true });
    }
    if ((m = path.match(/^\/api\/groups\/([A-Za-z0-9_-]+)\/songs\/([A-Za-z0-9_-]+)$/))) {
      const [, gid, sid] = m;
      this.needJoined(gid, me.id);
      const song = this.one('SELECT * FROM songs WHERE id = ? AND group_id = ?', sid, gid);
      if (!song) bad('השיר לא נמצא');
      const g = this.one('SELECT * FROM groups WHERE id = ?', gid);
      if (method === 'DELETE') {
        if (song.user_id !== me.id && g.owner !== me.id) throw new HttpError(403, 'אפשר למחוק רק שירים שלך');
        this.sql.exec('DELETE FROM songs WHERE id = ?', sid);
        return json({ ok: true });
      }
      if (method === 'PATCH') {
        if (song.user_id !== me.id) throw new HttpError(403, 'אפשר לשנות רק שירים שלך');
        const s = await resolveSong(body.input, this.lookup);
        if (!s.yt) bad('זה לא נראה כמו קישור מיוטיוב');
        this.sql.exec('UPDATE songs SET title = ?, artist = ?, yt = ?, thumb = ?, q = NULL WHERE id = ?',
          s.title || song.title, s.artist || song.artist, s.yt, s.thumb, sid);
        return json({ ok: true });
      }
    }

    throw new HttpError(404, 'לא נמצא');
  }

  relation(meId, otherId) {
    const f = this.friendship(meId, otherId);
    if (!f) return 'none';
    if (f.status === 'accepted') return 'friends';
    return f.requester === meId ? 'sent' : 'received';
  }

  invite(gid, me, ids) {
    if (!Array.isArray(ids)) return 0;
    let n = 0;
    for (const raw of ids.slice(0, 50)) {
      const uid = +raw;
      if (!uid || uid === me.id) continue;
      if (!this.areFriends(me.id, uid)) continue;
      if (this.membership(gid, uid)) continue;
      this.sql.exec("INSERT INTO members (group_id, user_id, status, invited_by, created) VALUES (?, ?, 'invited', ?, ?)", gid, uid, me.id, Date.now());
      n++;
    }
    return n;
  }

  home(me) {
    const rows = this.q(`SELECT f.*, u.id AS uid, u.username, u.display, u.color FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END
      WHERE f.a = ? OR f.b = ? ORDER BY u.display`, me.id, me.id, me.id);
    const pub = r => ({ id: r.uid, username: r.username, display: r.display, color: r.color });
    const friends = rows.filter(r => r.status === 'accepted').map(pub);
    const incoming = rows.filter(r => r.status === 'pending' && r.requester !== me.id).map(pub);
    const outgoing = rows.filter(r => r.status === 'pending' && r.requester === me.id).map(pub);
    const groups = this.q(`SELECT g.id, g.name, g.per, m.status, m.created AS since, m.invited_by,
        (SELECT COUNT(*) FROM songs s WHERE s.group_id = g.id) AS songs,
        (SELECT COUNT(*) FROM members x WHERE x.group_id = g.id AND x.status = 'joined') AS people,
        (SELECT MAX(created) FROM songs s WHERE s.group_id = g.id) AS last
      FROM members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY COALESCE(last, g.created) DESC`, me.id);
    const inviters = {};
    for (const g of groups) if (g.status === 'invited' && g.invited_by && !inviters[g.invited_by]) {
      inviters[g.invited_by] = this.pubUser(this.one('SELECT * FROM users WHERE id = ?', g.invited_by));
    }
    return {
      me: this.pubUser(me), friends, incoming, outgoing,
      invites: groups.filter(g => g.status === 'invited').map(g => ({ id: g.id, name: g.name, people: g.people, by: inviters[g.invited_by] || null })),
      groups: groups.filter(g => g.status === 'joined').map(g => ({ id: g.id, name: g.name, songs: g.songs, people: g.people, per: g.per }))
    };
  }

  groupView(gid, me) {
    const g = this.one('SELECT * FROM groups WHERE id = ?', gid);
    const mine = g && this.membership(gid, me.id);
    if (!g || !mine) throw new HttpError(404, 'הקבוצה לא נמצאה, או שאין לך הזמנה אליה');
    const members = this.q(`SELECT u.id, u.username, u.display, u.color, m.status, m.created FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ? ORDER BY m.status = 'invited', m.created`, gid);
    const songs = mine.status === 'joined'
      ? this.q('SELECT id, user_id, title, artist, yt, sp, thumb, q, created FROM songs WHERE group_id = ? ORDER BY created', gid)
      : [];
    return {
      group: { id: g.id, name: g.name, per: g.per, owner: g.owner },
      myStatus: mine.status,
      members, songs,
      songCount: this.one('SELECT COUNT(*) AS c FROM songs WHERE group_id = ?', gid).c
    };
  }
}
