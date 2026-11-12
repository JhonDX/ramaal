const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ldap = require('./ldap');

const app = express();
const PORT = 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'gacc-ba-ramal-secret-2024';
const DB_PATH = process.env.DB_PATH || '/data/ramal.db';

// Ensure data directory exists
const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Init tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ramais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cargo TEXT NOT NULL,
    setor TEXT NOT NULL,
    ramal TEXT NOT NULL,
    email TEXT,
    posicao INTEGER DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: add posicao column if not exists (for existing DBs)
try { db.exec('ALTER TABLE ramais ADD COLUMN posicao INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE ramais ADD COLUMN email TEXT'); } catch (_) {}
const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existingAdmin) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)').run('admin', hash, 'Administrador', 'admin');
}

// ─── GRUPOS DE PERMISSÃO ───
// Catálogo fixo de permissões. Cada grupo recebe um subconjunto delas e cada
// usuário pode estar em vários grupos; as permissões efetivas são a união.
const PERMISSIONS = [
  { key: 'ramais.gerenciar',   label: 'Gerenciar ramais',              desc: 'Criar, editar, ordenar e excluir ramais' },
  { key: 'usuarios.gerenciar', label: 'Gerenciar usuários',            desc: 'Criar, editar e excluir usuários e vinculá-los a grupos' },
  { key: 'grupos.gerenciar',   label: 'Gerenciar grupos de permissão', desc: 'Criar e editar grupos e o mapeamento com grupos do LDAP' },
  { key: 'config.gerenciar',   label: 'Configurações do sistema',      desc: 'Configurar a integração LDAP / Active Directory' },
];
const PERMISSION_KEYS = PERMISSIONS.map(p => p.key);

db.exec(`
  CREATE TABLE IF NOT EXISTS grupos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT UNIQUE NOT NULL,
    descricao TEXT DEFAULT '',
    permissoes TEXT NOT NULL DEFAULT '[]',
    ldap_grupos TEXT DEFAULT '',
    sistema INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_grupos (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    grupo_id INTEGER NOT NULL REFERENCES grupos(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, grupo_id)
  );

  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT
  );
`);
db.pragma('foreign_keys = ON');
try { db.exec("ALTER TABLE users ADD COLUMN origem TEXT DEFAULT 'local'"); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN ativo INTEGER DEFAULT 1'); } catch (_) {}
try { db.exec('ALTER TABLE users ADD COLUMN ultimo_login DATETIME'); } catch (_) {}
// De onde veio o vínculo usuário ↔ grupo: 'manual' (feito no admin) ou 'ldap'
// (sincronizado pelo memberOf no login). O login só remove vínculos 'ldap'.
try {
  db.exec("ALTER TABLE user_grupos ADD COLUMN origem TEXT DEFAULT 'manual'");
  db.exec(`UPDATE user_grupos SET origem = 'ldap'
    WHERE user_id IN (SELECT id FROM users WHERE origem = 'ldap')
      AND grupo_id IN (SELECT id FROM grupos WHERE TRIM(COALESCE(ldap_grupos, '')) <> '')`);
} catch (_) {}

// Grupo "Administradores": tem sempre todas as permissões e não pode ser excluído.
let adminGroup = db.prepare('SELECT id FROM grupos WHERE sistema = 1').get();
if (!adminGroup) {
  const r = db.prepare('INSERT INTO grupos (nome, descricao, permissoes, sistema) VALUES (?, ?, ?, 1)')
    .run('Administradores', 'Acesso total ao sistema', JSON.stringify(PERMISSION_KEYS));
  adminGroup = { id: r.lastInsertRowid };
  db.prepare('INSERT INTO grupos (nome, descricao, permissoes) VALUES (?, ?, ?)')
    .run('Editores de Ramais', 'Podem manter a lista de ramais', JSON.stringify(['ramais.gerenciar']));
  // Bancos antigos: todo usuário que já existia era administrador.
  db.prepare('INSERT OR IGNORE INTO user_grupos (user_id, grupo_id) SELECT id, ? FROM users').run(adminGroup.id);
}
db.prepare('UPDATE grupos SET permissoes = ? WHERE sistema = 1').run(JSON.stringify(PERMISSION_KEYS));

// ─── CONFIGURAÇÕES (salvas no banco, editadas pelo admin) ───
const LDAP_DEFAULTS = {
  enabled: false,
  url: '',
  starttls: false,
  tls_reject_unauthorized: true,
  bind_dn: '',
  bind_password: '',
  base_dn: '',
  user_filter: '(sAMAccountName={{username}})',
  attr_name: 'displayName',
  attr_email: 'mail',
  default_group_id: null,
};
function getLdapConfig() {
  const row = db.prepare("SELECT valor FROM config WHERE chave = 'ldap'").get();
  let saved = {};
  try { saved = row ? JSON.parse(row.valor) : {}; } catch (_) {}
  return { ...LDAP_DEFAULTS, ...saved };
}
function saveLdapConfig(cfg) {
  db.prepare("INSERT INTO config (chave, valor) VALUES ('ldap', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor")
    .run(JSON.stringify(cfg));
}
// Nunca devolve a senha da conta de serviço para o navegador.
function publicLdapConfig(cfg) {
  const { bind_password, ...rest } = cfg;
  return { ...rest, bind_password_set: !!bind_password };
}

// Seed sample data
const count = db.prepare('SELECT COUNT(*) as c FROM ramais').get();
if (count.c === 0) {
  const ramaisSample = [
    { nome: 'Ana Paula Souza', cargo: 'Assistente Social', setor: 'Serviço Social', ramal: '1001', email: 'ana.paula@gacc-ba.org.br', posicao: 1 },
    { nome: 'Carlos Eduardo Lima', cargo: 'Médico Oncologista', setor: 'Oncologia', ramal: '1002', email: 'carlos.lima@gacc-ba.org.br', posicao: 1 },
    { nome: 'Fernanda Oliveira', cargo: 'Enfermeira Chefe', setor: 'Enfermagem', ramal: '1003', email: 'fernanda.oliveira@gacc-ba.org.br', posicao: 1 },
    { nome: 'Roberto Santos', cargo: 'Diretor Executivo', setor: 'Diretoria', ramal: '1000', email: 'diretor@gacc-ba.org.br', posicao: 1 },
    { nome: 'Mariana Costa', cargo: 'Psicóloga', setor: 'Psicologia', ramal: '1004', email: 'mariana.costa@gacc-ba.org.br', posicao: 1 },
    { nome: 'João Batista', cargo: 'Coordenador de TI', setor: 'Tecnologia', ramal: '1005', email: 'joao.ti@gacc-ba.org.br', posicao: 1 },
    { nome: 'Luciana Ferreira', cargo: 'Nutricionista', setor: 'Nutrição', ramal: '1006', email: 'luciana.ferreira@gacc-ba.org.br', posicao: 1 },
    { nome: 'Pedro Henrique', cargo: 'Recepcionista', setor: 'Recepção', ramal: '1007', email: 'recepcao@gacc-ba.org.br', posicao: 1 },
  ];
  const insert = db.prepare('INSERT INTO ramais (nome, cargo, setor, ramal, email, posicao) VALUES (?, ?, ?, ?, ?, ?)');
  ramaisSample.forEach(r => insert.run(r.nome, r.cargo, r.setor, r.ramal, r.email, r.posicao));
}

app.use(cors());
app.use(express.json());

// ─── PERMISSÕES ───
function parsePerms(json) {
  try { return JSON.parse(json || '[]').filter(p => PERMISSION_KEYS.includes(p)); } catch (_) { return []; }
}
function userGroups(userId) {
  return db.prepare(`SELECT g.id, g.nome, g.permissoes, ug.origem FROM grupos g
    JOIN user_grupos ug ON ug.grupo_id = g.id WHERE ug.user_id = ? ORDER BY g.nome`).all(userId);
}
function userPermissions(userId) {
  const set = new Set();
  userGroups(userId).forEach(g => parsePerms(g.permissoes).forEach(p => set.add(p)));
  return [...set];
}
function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, email: u.email || '',
    origem: u.origem || 'local', ativo: u.ativo ?? 1,
    grupos: userGroups(u.id).map(g => ({ id: g.id, nome: g.nome, origem: g.origem || 'manual' })),
    permissoes: userPermissions(u.id),
  };
}

// Garante que sempre sobra pelo menos um usuário ativo capaz de gerenciar
// grupos e usuários; senão ninguém mais conseguiria administrar o sistema.
function assertAdminRemains() {
  const users = db.prepare('SELECT id FROM users WHERE ativo = 1').all();
  const ok = users.some(u => {
    const p = userPermissions(u.id);
    return p.includes('usuarios.gerenciar') && p.includes('grupos.gerenciar');
  });
  if (!ok) {
    const e = new Error('A alteração deixaria o sistema sem nenhum administrador ativo');
    e.status = 400;
    throw e;
  }
}
// Executa uma alteração e desfaz tudo se ela deixar o sistema sem administrador.
function guarded(fn) {
  return db.transaction(() => { const r = fn(); assertAdminRemains(); return r; })();
}

// Auth middleware: o token só identifica o usuário. Permissões e status são
// lidos do banco a cada requisição, então mudanças valem na hora.
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user || !user.ativo) return res.status(401).json({ error: 'Usuário inativo ou removido' });
  req.user = user;
  req.perms = userPermissions(user.id);
  next();
};
const can = perm => (req, res, next) =>
  req.perms.includes(perm) ? next() : res.status(403).json({ error: 'Você não tem permissão para esta ação' });

// Vincula o usuário do LDAP aos grupos mapeados. Vínculos feitos à mão em
// grupos sem mapeamento LDAP são mantidos.
function syncLdapGroups(userId, memberOf, cfg) {
  const grupos = db.prepare('SELECT id, ldap_grupos FROM grupos').all();
  const mapped = grupos.filter(g => (g.ldap_grupos || '').trim());
  // Vínculos feitos à mão no admin nunca são removidos pela sincronização.
  const del = db.prepare("DELETE FROM user_grupos WHERE user_id = ? AND grupo_id = ? AND origem = 'ldap'");
  const ins = db.prepare("INSERT OR IGNORE INTO user_grupos (user_id, grupo_id, origem) VALUES (?, ?, 'ldap')");
  mapped.forEach(g => {
    const values = g.ldap_grupos.split(/\r?\n|;/);
    if (ldap.matchesGroup(memberOf, values)) ins.run(userId, g.id); else del.run(userId, g.id);
  });
  const hasAny = db.prepare('SELECT 1 FROM user_grupos WHERE user_id = ?').get(userId);
  if (!hasAny && cfg.default_group_id) {
    const exists = db.prepare('SELECT id FROM grupos WHERE id = ?').get(cfg.default_group_id);
    if (exists) ins.run(userId, cfg.default_group_id);
  }
}

function issueToken(user) {
  db.prepare('UPDATE users SET ultimo_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '8h' });
  return { token, user: publicUser(user) };
}

// LOGIN: usuários locais usam a senha do sistema; os demais são validados no LDAP.
app.post('/api/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha' });

  let user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);

  if (user && (user.origem || 'local') === 'local') {
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Credenciais inválidas' });
  } else {
    const cfg = getLdapConfig();
    if (!cfg.enabled || !cfg.url || !cfg.base_dn) return res.status(401).json({ error: 'Credenciais inválidas' });
    let info;
    try {
      info = await ldap.authenticate(cfg, username, password);
    } catch (e) {
      console.error('Erro no LDAP:', e.message);
      return res.status(502).json({ error: 'Não foi possível falar com o servidor LDAP. Tente novamente ou fale com a TI.' });
    }
    if (!info) return res.status(401).json({ error: 'Credenciais inválidas' });
    db.transaction(() => {
      if (!user) {
        const r = db.prepare("INSERT INTO users (username, password, name, email, origem, role) VALUES (?, '!', ?, ?, 'ldap', '')")
          .run(username.toLowerCase(), info.name, info.email);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
      } else {
        db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(info.name, info.email, user.id);
      }
      syncLdapGroups(user.id, info.memberOf, cfg);
    })();
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  if (!user.ativo) return res.status(403).json({ error: 'Usuário desativado. Fale com a TI.' });
  if (!userPermissions(user.id).length)
    return res.status(403).json({ error: 'Seu usuário não está em nenhum grupo de permissão. Fale com a TI.' });
  res.json(issueToken(user));
});

app.get('/api/admin/me', auth, (req, res) => res.json(publicUser(req.user)));
app.get('/api/admin/permissions', auth, (req, res) => res.json(PERMISSIONS));

// PUBLIC: List ramais
app.get('/api/ramais', (req, res) => {
  const { search, setor } = req.query;
  let query = 'SELECT * FROM ramais WHERE ativo = 1';
  const params = [];
  if (setor) { query += ' AND setor = ?'; params.push(setor); }
  query += ' ORDER BY CASE WHEN posicao = 0 OR posicao IS NULL THEN 1 ELSE 0 END, posicao ASC, setor, nome';
  let rows = db.prepare(query).all(...params);
  // Filtra em JS para ignorar acentos e maiúsculas ("joao" encontra "João").
  if (search) {
    const norm = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const q = norm(search.trim());
    rows = rows.filter(r => [r.nome, r.cargo, r.ramal, r.email, r.setor].some(v => norm(v).includes(q)));
  }
  res.json(rows);
});

// PUBLIC: List setores
app.get('/api/setores', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT setor FROM ramais WHERE ativo = 1 ORDER BY setor').all();
  res.json(rows.map(r => r.setor));
});

// ADMIN: All ramais (including inactive)
app.get('/api/admin/ramais', auth, can('ramais.gerenciar'), (req, res) => {
  res.json(db.prepare('SELECT * FROM ramais ORDER BY CASE WHEN posicao = 0 OR posicao IS NULL THEN 1 ELSE 0 END, posicao ASC, setor, nome').all());
});

// ADMIN: Create ramal
app.post('/api/admin/ramais', auth, can('ramais.gerenciar'), (req, res) => {
  const { nome, cargo, setor, ramal, email, ativo, posicao } = req.body;
  if (!nome || !cargo || !setor || !ramal)
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  const result = db.prepare('INSERT INTO ramais (nome, cargo, setor, ramal, email, ativo, posicao) VALUES (?, ?, ?, ?, ?, ?, ?)').run(nome, cargo, setor, ramal, email || '', ativo ?? 1, posicao ?? 0);
  res.json({ id: result.lastInsertRowid, message: 'Ramal criado com sucesso' });
});

// ADMIN: Update ramal
app.put('/api/admin/ramais/:id', auth, can('ramais.gerenciar'), (req, res) => {
  const { nome, cargo, setor, ramal, email, ativo, posicao } = req.body;
  db.prepare('UPDATE ramais SET nome=?, cargo=?, setor=?, ramal=?, email=?, ativo=?, posicao=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(nome, cargo, setor, ramal, email || '', ativo, posicao ?? 0, req.params.id);
  res.json({ message: 'Ramal atualizado com sucesso' });
});

// ADMIN: Delete ramal
app.delete('/api/admin/ramais/:id', auth, can('ramais.gerenciar'), (req, res) => {
  db.prepare('DELETE FROM ramais WHERE id=?').run(req.params.id);
  res.json({ message: 'Ramal removido com sucesso' });
});

// ─── USUÁRIOS ───
function setUserGroups(userId, grupoIds) {
  if (!Array.isArray(grupoIds)) return;
  const valid = new Set(db.prepare('SELECT id FROM grupos').all().map(g => g.id));
  const wanted = new Set(grupoIds.map(Number).filter(id => valid.has(id)));
  // Remove só o que foi desmarcado; os que continuam mantêm a origem (manual/ldap).
  db.prepare('SELECT grupo_id FROM user_grupos WHERE user_id = ?').all(userId)
    .filter(r => !wanted.has(r.grupo_id))
    .forEach(r => db.prepare('DELETE FROM user_grupos WHERE user_id = ? AND grupo_id = ?').run(userId, r.grupo_id));
  const ins = db.prepare("INSERT OR IGNORE INTO user_grupos (user_id, grupo_id, origem) VALUES (?, ?, 'manual')");
  wanted.forEach(id => ins.run(userId, id));
}
const sendError = (res, e, fallback) => res.status(e.status || 400).json({ error: e.status ? e.message : fallback });

app.get('/api/admin/users', auth, can('usuarios.gerenciar'), (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY name').all();
  res.json(users.map(u => ({ ...publicUser(u), created_at: u.created_at, ultimo_login: u.ultimo_login })));
});

// Cria um usuário local (com senha) ou pré-cadastra um usuário do LDAP (sem senha),
// para já deixá-lo vinculado aos grupos antes do primeiro login.
app.post('/api/admin/users', auth, can('usuarios.gerenciar'), (req, res) => {
  const { username, password, name, email, origem, grupos } = req.body;
  const isLdap = origem === 'ldap';
  if (!username || !name || (!isLdap && !password))
    return res.status(400).json({ error: isLdap ? 'Campos obrigatórios: usuário e nome' : 'Campos obrigatórios: usuário, nome e senha' });
  if (!isLdap && password.length < 6) return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres' });
  try {
    const id = guarded(() => {
      const hash = isLdap ? '!' : bcrypt.hashSync(password, 10);
      const r = db.prepare('INSERT INTO users (username, password, name, email, origem, role) VALUES (?, ?, ?, ?, ?, ?)')
        .run(isLdap ? username.toLowerCase() : username, hash, name, email || '', isLdap ? 'ldap' : 'local', '');
      setUserGroups(r.lastInsertRowid, grupos || []);
      return r.lastInsertRowid;
    });
    res.json({ id, message: 'Usuário criado com sucesso' });
  } catch (e) {
    sendError(res, e, 'Esse usuário já existe');
  }
});

app.put('/api/admin/users/:id', auth, can('usuarios.gerenciar'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { name, email, password, ativo, grupos } = req.body;
  if (password && user.origem === 'ldap') return res.status(400).json({ error: 'A senha de usuários do LDAP é alterada no próprio AD' });
  if (password && password.length < 6) return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres' });
  try {
    guarded(() => {
      db.prepare('UPDATE users SET name = ?, email = ?, ativo = ? WHERE id = ?')
        .run(name || user.name, email ?? user.email ?? '', ativo === undefined ? user.ativo : (ativo ? 1 : 0), user.id);
      if (password) db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
      setUserGroups(user.id, grupos);
    });
    res.json({ message: 'Usuário atualizado com sucesso' });
  } catch (e) {
    sendError(res, e, 'Não foi possível atualizar o usuário');
  }
});

app.delete('/api/admin/users/:id', auth, can('usuarios.gerenciar'), (req, res) => {
  if (req.user.id == req.params.id)
    return res.status(400).json({ error: 'Não é possível excluir o próprio usuário' });
  try {
    guarded(() => db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id));
    res.json({ message: 'Usuário removido com sucesso' });
  } catch (e) {
    sendError(res, e, 'Não foi possível remover o usuário');
  }
});

// ─── GRUPOS DE PERMISSÃO ───
function publicGroup(g) {
  return {
    id: g.id, nome: g.nome, descricao: g.descricao || '', sistema: !!g.sistema,
    permissoes: parsePerms(g.permissoes),
    ldap_grupos: (g.ldap_grupos || '').split(/\r?\n|;/).map(v => v.trim()).filter(Boolean),
    membros: db.prepare('SELECT COUNT(*) AS c FROM user_grupos WHERE grupo_id = ?').get(g.id).c,
  };
}
function groupPayload(body) {
  const ldapList = Array.isArray(body.ldap_grupos) ? body.ldap_grupos : String(body.ldap_grupos || '').split(/\r?\n|;/);
  return {
    nome: String(body.nome || '').trim(),
    descricao: String(body.descricao || '').trim(),
    permissoes: JSON.stringify((body.permissoes || []).filter(p => PERMISSION_KEYS.includes(p))),
    ldap_grupos: ldapList.map(v => String(v).trim()).filter(Boolean).join('\n'),
  };
}

app.get('/api/admin/grupos', auth, (req, res) => {
  // Quem gerencia usuários precisa ver os grupos para vincular.
  if (!req.perms.includes('grupos.gerenciar') && !req.perms.includes('usuarios.gerenciar'))
    return res.status(403).json({ error: 'Você não tem permissão para esta ação' });
  res.json(db.prepare('SELECT * FROM grupos ORDER BY sistema DESC, nome').all().map(publicGroup));
});

app.post('/api/admin/grupos', auth, can('grupos.gerenciar'), (req, res) => {
  const g = groupPayload(req.body);
  if (!g.nome) return res.status(400).json({ error: 'Informe o nome do grupo' });
  try {
    const r = db.prepare('INSERT INTO grupos (nome, descricao, permissoes, ldap_grupos) VALUES (?, ?, ?, ?)')
      .run(g.nome, g.descricao, g.permissoes, g.ldap_grupos);
    res.json({ id: r.lastInsertRowid, message: 'Grupo criado com sucesso' });
  } catch (e) {
    res.status(400).json({ error: 'Já existe um grupo com esse nome' });
  }
});

app.put('/api/admin/grupos/:id', auth, can('grupos.gerenciar'), (req, res) => {
  const atual = db.prepare('SELECT * FROM grupos WHERE id = ?').get(req.params.id);
  if (!atual) return res.status(404).json({ error: 'Grupo não encontrado' });
  const g = groupPayload(req.body);
  if (!g.nome) return res.status(400).json({ error: 'Informe o nome do grupo' });
  // O grupo Administradores mantém sempre todas as permissões.
  if (atual.sistema) g.permissoes = JSON.stringify(PERMISSION_KEYS);
  try {
    guarded(() => db.prepare('UPDATE grupos SET nome = ?, descricao = ?, permissoes = ?, ldap_grupos = ? WHERE id = ?')
      .run(g.nome, g.descricao, g.permissoes, g.ldap_grupos, atual.id));
    res.json({ message: 'Grupo atualizado com sucesso' });
  } catch (e) {
    sendError(res, e, 'Já existe um grupo com esse nome');
  }
});

app.delete('/api/admin/grupos/:id', auth, can('grupos.gerenciar'), (req, res) => {
  const g = db.prepare('SELECT * FROM grupos WHERE id = ?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Grupo não encontrado' });
  if (g.sistema) return res.status(400).json({ error: 'O grupo Administradores não pode ser excluído' });
  try {
    guarded(() => db.prepare('DELETE FROM grupos WHERE id = ?').run(g.id));
    res.json({ message: 'Grupo removido com sucesso' });
  } catch (e) {
    sendError(res, e, 'Não foi possível remover o grupo');
  }
});

// ─── BUSCAR E IMPORTAR USUÁRIOS DO AD ───
function ldapReady(res) {
  const cfg = getLdapConfig();
  if (!cfg.url || !cfg.base_dn) { res.status(400).json({ error: 'Configure a integração LDAP antes de buscar usuários no AD' }); return null; }
  return cfg;
}

// Busca pessoas no AD e indica quem já está cadastrado e em quais grupos.
app.get('/api/admin/ldap/users', auth, can('usuarios.gerenciar'), async (req, res) => {
  const cfg = ldapReady(res); if (!cfg) return;
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Digite pelo menos 2 letras para buscar' });
  try {
    const { users, truncado } = await ldap.searchUsers(cfg, q);
    const local = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
    res.json({
      truncado,
      usuarios: users.map(u => {
        const existing = local.get(u.username);
        return { ...u, cadastrado: existing ? { id: existing.id, origem: existing.origem, grupos: userGroups(existing.id).map(g => g.id) } : null };
      }),
    });
  } catch (e) {
    res.status(502).json({ error: 'Erro ao buscar no AD: ' + e.message });
  }
});

// Cadastra (se ainda não existir) os usuários escolhidos do AD e os adiciona aos grupos.
// Não tira ninguém de grupos que já tinha.
app.post('/api/admin/ldap/import', auth, can('usuarios.gerenciar'), (req, res) => {
  const lista = Array.isArray(req.body.usuarios) ? req.body.usuarios : [];
  const valid = new Set(db.prepare('SELECT id FROM grupos').all().map(g => g.id));
  const grupos = (req.body.grupos || []).map(Number).filter(id => valid.has(id));
  if (!lista.length) return res.status(400).json({ error: 'Selecione pelo menos um usuário' });
  if (!grupos.length) return res.status(400).json({ error: 'Selecione pelo menos um grupo' });
  let criados = 0, vinculados = 0;
  db.transaction(() => {
    const find = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
    const create = db.prepare("INSERT INTO users (username, password, name, email, origem, role) VALUES (?, '!', ?, ?, 'ldap', '')");
    const link = db.prepare("INSERT OR IGNORE INTO user_grupos (user_id, grupo_id, origem) VALUES (?, ?, 'manual')");
    lista.forEach(u => {
      const username = String(u.username || '').trim().toLowerCase();
      if (!username) return;
      let user = find.get(username);
      if (!user) {
        const r = create.run(username, String(u.name || username), String(u.email || ''));
        user = { id: r.lastInsertRowid };
        criados++;
      }
      grupos.forEach(g => { vinculados += link.run(user.id, g).changes; });
    });
  })();
  res.json({ message: `${lista.length} usuário(s) vinculados (${criados} novo(s) cadastrado(s))`, criados, vinculados });
});

// ─── CONFIGURAÇÃO LDAP ───
function ldapPayload(body, atual) {
  const cfg = { ...atual };
  ['url', 'bind_dn', 'base_dn', 'user_filter', 'attr_name', 'attr_email'].forEach(k => {
    if (body[k] !== undefined) cfg[k] = String(body[k]).trim();
  });
  ['enabled', 'starttls', 'tls_reject_unauthorized'].forEach(k => {
    if (body[k] !== undefined) cfg[k] = !!body[k];
  });
  if (body.default_group_id !== undefined) cfg.default_group_id = body.default_group_id ? Number(body.default_group_id) : null;
  // Senha em branco mantém a atual; só troca se vier preenchida ou se pedir para limpar.
  if (body.bind_password) cfg.bind_password = String(body.bind_password);
  if (body.clear_bind_password) cfg.bind_password = '';
  if (!cfg.user_filter) cfg.user_filter = LDAP_DEFAULTS.user_filter;
  return cfg;
}
function validateLdap(cfg) {
  if (!/^ldaps?:\/\//i.test(cfg.url)) return 'O endereço deve começar com ldap:// ou ldaps://';
  if (!cfg.base_dn) return 'Informe a Base DN';
  if (!cfg.user_filter.includes('{{username}}')) return 'O filtro de usuário precisa conter {{username}}';
  return null;
}

app.get('/api/admin/config/ldap', auth, can('config.gerenciar'), (req, res) => {
  res.json(publicLdapConfig(getLdapConfig()));
});

app.put('/api/admin/config/ldap', auth, can('config.gerenciar'), (req, res) => {
  const cfg = ldapPayload(req.body, getLdapConfig());
  if (cfg.enabled || cfg.url) {
    const err = validateLdap(cfg);
    if (err) return res.status(400).json({ error: err });
  }
  saveLdapConfig(cfg);
  res.json({ message: 'Configuração LDAP salva', config: publicLdapConfig(cfg) });
});

// Testa a configuração do formulário (antes ou depois de salvar). Se vier um
// usuário, mostra o que o sistema encontrou no AD e em quais grupos ele cairia.
app.post('/api/admin/config/ldap/test', auth, can('config.gerenciar'), async (req, res) => {
  const cfg = ldapPayload(req.body, getLdapConfig());
  const err = validateLdap(cfg);
  if (err) return res.status(400).json({ error: err });
  try {
    await ldap.testConnection(cfg);
  } catch (e) {
    return res.status(400).json({ error: 'Falha ao conectar: ' + e.message });
  }
  const username = String(req.body.test_username || '').trim();
  if (!username) return res.json({ message: 'Conexão e conta de serviço OK' });
  try {
    const password = String(req.body.test_password || '');
    const info = password ? await ldap.authenticate(cfg, username, password) : await ldap.findUser(cfg, username);
    if (!info) {
      return res.status(400).json({ error: password ? 'Usuário não encontrado ou senha incorreta' : 'Usuário não encontrado com esse filtro' });
    }
    const grupos = db.prepare('SELECT id, nome, ldap_grupos FROM grupos').all()
      .filter(g => (g.ldap_grupos || '').trim() && ldap.matchesGroup(info.memberOf, g.ldap_grupos.split(/\r?\n|;/)))
      .map(g => g.nome);
    res.json({
      message: password ? 'Usuário e senha válidos' : 'Usuário encontrado',
      usuario: { dn: info.dn, nome: info.name, email: info.email, memberOf: info.memberOf },
      grupos_do_sistema: grupos,
    });
  } catch (e) {
    res.status(400).json({ error: 'Erro na busca: ' + e.message });
  }
});

// Stats
app.get('/api/admin/stats', auth, (req, res) => {
  const totalRamais = db.prepare('SELECT COUNT(*) as c FROM ramais WHERE ativo=1').get().c;
  const totalSetores = db.prepare('SELECT COUNT(DISTINCT setor) as c FROM ramais WHERE ativo=1').get().c;
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalInativos = db.prepare('SELECT COUNT(*) as c FROM ramais WHERE ativo=0').get().c;
  res.json({ totalRamais, totalSetores, totalUsers, totalInativos });
});

app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
