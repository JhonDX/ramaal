const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'gacc-ba-ramal-secret-2024';
const DB_PATH = '/data/ramal.db';

// Ensure data directory exists
if (!fs.existsSync('/data')) fs.mkdirSync('/data', { recursive: true });

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
    email TEXT NOT NULL,
    ativo INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default admin
const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existingAdmin) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)').run('admin', hash, 'Administrador', 'admin');
}

// Seed sample data
const count = db.prepare('SELECT COUNT(*) as c FROM ramais').get();
if (count.c === 0) {
  const ramaisSample = [
    { nome: 'Ana Paula Souza', cargo: 'Assistente Social', setor: 'Serviço Social', ramal: '1001', email: 'ana.paula@gacc-ba.org.br' },
    { nome: 'Carlos Eduardo Lima', cargo: 'Médico Oncologista', setor: 'Oncologia', ramal: '1002', email: 'carlos.lima@gacc-ba.org.br' },
    { nome: 'Fernanda Oliveira', cargo: 'Enfermeira Chefe', setor: 'Enfermagem', ramal: '1003', email: 'fernanda.oliveira@gacc-ba.org.br' },
    { nome: 'Roberto Santos', cargo: 'Diretor Executivo', setor: 'Diretoria', ramal: '1000', email: 'diretor@gacc-ba.org.br' },
    { nome: 'Mariana Costa', cargo: 'Psicóloga', setor: 'Psicologia', ramal: '1004', email: 'mariana.costa@gacc-ba.org.br' },
    { nome: 'João Batista', cargo: 'Coordenador de TI', setor: 'Tecnologia', ramal: '1005', email: 'joao.ti@gacc-ba.org.br' },
    { nome: 'Luciana Ferreira', cargo: 'Nutricionista', setor: 'Nutrição', ramal: '1006', email: 'luciana.ferreira@gacc-ba.org.br' },
    { nome: 'Pedro Henrique', cargo: 'Recepcionista', setor: 'Recepção', ramal: '1007', email: 'recepcao@gacc-ba.org.br' },
  ];
  const insert = db.prepare('INSERT INTO ramais (nome, cargo, setor, ramal, email) VALUES (?, ?, ?, ?, ?)');
  ramaisSample.forEach(r => insert.run(r.nome, r.cargo, r.setor, r.ramal, r.email));
}

app.use(cors());
app.use(express.json());

// Auth middleware
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// LOGIN
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Credenciais inválidas' });
  const token = jwt.sign({ id: user.id, username: user.username, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

// PUBLIC: List ramais
app.get('/api/ramais', (req, res) => {
  const { search, setor } = req.query;
  let query = 'SELECT * FROM ramais WHERE ativo = 1';
  const params = [];
  if (search) {
    query += ' AND (nome LIKE ? OR cargo LIKE ? OR ramal LIKE ? OR email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (setor) { query += ' AND setor = ?'; params.push(setor); }
  query += ' ORDER BY setor, nome';
  res.json(db.prepare(query).all(...params));
});

// PUBLIC: List setores
app.get('/api/setores', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT setor FROM ramais WHERE ativo = 1 ORDER BY setor').all();
  res.json(rows.map(r => r.setor));
});

// ADMIN: All ramais (including inactive)
app.get('/api/admin/ramais', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM ramais ORDER BY setor, nome').all());
});

// ADMIN: Create ramal
app.post('/api/admin/ramais', auth, (req, res) => {
  const { nome, cargo, setor, ramal, email, ativo } = req.body;
  if (!nome || !cargo || !setor || !ramal)
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  const result = db.prepare('INSERT INTO ramais (nome, cargo, setor, ramal, email, ativo) VALUES (?, ?, ?, ?, ?, ?)').run(nome, cargo, setor, ramal, email, ativo ?? 1);
  res.json({ id: result.lastInsertRowid, message: 'Ramal criado com sucesso' });
});

// ADMIN: Update ramal
app.put('/api/admin/ramais/:id', auth, (req, res) => {
  const { nome, cargo, setor, ramal, email, ativo } = req.body;
  db.prepare('UPDATE ramais SET nome=?, cargo=?, setor=?, ramal=?, email=?, ativo=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(nome, cargo, setor, ramal, email, ativo, req.params.id);
  res.json({ message: 'Ramal atualizado com sucesso' });
});

// ADMIN: Delete ramal
app.delete('/api/admin/ramais/:id', auth, (req, res) => {
  db.prepare('DELETE FROM ramais WHERE id=?').run(req.params.id);
  res.json({ message: 'Ramal removido com sucesso' });
});

// ADMIN: List users
app.get('/api/admin/users', auth, (req, res) => {
  res.json(db.prepare('SELECT id, username, name, role, created_at FROM users ORDER BY name').all());
});

// ADMIN: Create user
app.post('/api/admin/users', auth, (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name)
    return res.status(400).json({ error: 'Campos obrigatórios: username, password, name' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)').run(username, hash, name, role || 'admin');
    res.json({ id: result.lastInsertRowid, message: 'Usuário criado com sucesso' });
  } catch (e) {
    res.status(400).json({ error: 'Username já existe' });
  }
});

// ADMIN: Update user
app.put('/api/admin/users/:id', auth, (req, res) => {
  const { name, role, password } = req.body;
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET name=?, role=?, password=? WHERE id=?').run(name, role, hash, req.params.id);
  } else {
    db.prepare('UPDATE users SET name=?, role=? WHERE id=?').run(name, role, req.params.id);
  }
  res.json({ message: 'Usuário atualizado com sucesso' });
});

// ADMIN: Delete user
app.delete('/api/admin/users/:id', auth, (req, res) => {
  if (req.user.id == req.params.id)
    return res.status(400).json({ error: 'Não é possível excluir o próprio usuário' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ message: 'Usuário removido com sucesso' });
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
