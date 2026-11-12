// Autenticação via LDAP / Active Directory.
// A configuração vem do banco (tela "Configurações > LDAP" do admin).
const { Client } = require('ldapts');

// Escapa um valor para uso dentro de um filtro LDAP (RFC 4515).
function escapeFilter(value) {
  return String(value).replace(/[\\*()\0]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function makeClient(cfg) {
  const opts = { url: cfg.url, timeout: 8000, connectTimeout: 8000 };
  // O ldapts abre TLS sempre que recebe tlsOptions, então só passa para ldaps://.
  if (/^ldaps:/i.test(cfg.url)) opts.tlsOptions = { rejectUnauthorized: cfg.tls_reject_unauthorized !== false };
  return new Client(opts);
}

async function startTlsIfNeeded(client, cfg) {
  if (cfg.starttls && cfg.url.startsWith('ldap://')) {
    await client.startTLS({ rejectUnauthorized: cfg.tls_reject_unauthorized !== false });
  }
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function firstValue(v) {
  const arr = asArray(v);
  return arr.length ? String(arr[0]) : '';
}

// Conecta com a conta de serviço (ou anônimo) e procura o usuário.
async function findUser(cfg, username) {
  const client = makeClient(cfg);
  try {
    await startTlsIfNeeded(client, cfg);
    if (cfg.bind_dn) await client.bind(cfg.bind_dn, cfg.bind_password || '');
    const filter = (cfg.user_filter || '(sAMAccountName={{username}})')
      .split('{{username}}').join(escapeFilter(username));
    const nameAttr = cfg.attr_name || 'displayName';
    const emailAttr = cfg.attr_email || 'mail';
    const { searchEntries } = await client.search(cfg.base_dn, {
      scope: 'sub',
      filter,
      attributes: ['dn', nameAttr, emailAttr, 'memberOf', 'cn'],
      sizeLimit: 2,
    });
    if (searchEntries.length !== 1) return null;
    const e = searchEntries[0];
    return {
      dn: e.dn,
      name: firstValue(e[nameAttr]) || firstValue(e.cn) || username,
      email: firstValue(e[emailAttr]),
      memberOf: asArray(e.memberOf).map(String),
    };
  } finally {
    await client.unbind().catch(() => {});
  }
}

// Confere a senha fazendo bind com o DN do próprio usuário.
async function verifyPassword(cfg, dn, password) {
  const client = makeClient(cfg);
  try {
    await startTlsIfNeeded(client, cfg);
    await client.bind(dn, password);
    return true;
  } catch {
    return false;
  } finally {
    await client.unbind().catch(() => {});
  }
}

// Retorna os dados do usuário se usuário e senha forem válidos no LDAP, senão null.
async function authenticate(cfg, username, password) {
  // Senha vazia faria um "bind anônimo" que o servidor aceita: nunca permitir.
  if (!username || !password) return null;
  const user = await findUser(cfg, username);
  if (!user) return null;
  const ok = await verifyPassword(cfg, user.dn, password);
  return ok ? user : null;
}

// Descobre o atributo de login a partir do filtro: "(sAMAccountName={{username}})" -> "sAMAccountName".
function loginAttr(cfg) {
  const m = /\(\s*([\w-]+)\s*=\s*\{\{username\}\}\s*\)/.exec(cfg.user_filter || '');
  return m ? m[1] : 'sAMAccountName';
}

// Procura pessoas no diretório pelo login, nome ou e-mail (para o admin escolher quem cadastrar).
async function searchUsers(cfg, term, limit = 50) {
  const client = makeClient(cfg);
  const login = loginAttr(cfg);
  const nameAttr = cfg.attr_name || 'displayName';
  const emailAttr = cfg.attr_email || 'mail';
  const t = escapeFilter(term);
  const filter = `(&(objectClass=person)(${login}=*)` +
    `(|(${login}=*${t}*)(${nameAttr}=*${t}*)(${emailAttr}=*${t}*)(cn=*${t}*))` +
    // Esconde contas desativadas do AD (bit 2 do userAccountControl); outros servidores ignoram.
    (/samaccountname/i.test(login) ? '(!(userAccountControl:1.2.840.113556.1.4.803:=2))' : '') + ')';
  try {
    await startTlsIfNeeded(client, cfg);
    if (cfg.bind_dn) await client.bind(cfg.bind_dn, cfg.bind_password || '');
    let entries = [];
    let truncado = false;
    try {
      ({ searchEntries: entries } = await client.search(cfg.base_dn, {
        scope: 'sub', filter, sizeLimit: limit,
        attributes: ['dn', login, nameAttr, emailAttr, 'cn', 'memberOf'],
      }));
    } catch (e) {
      // Mais resultados do que o limite: o servidor recusa; peça uma busca mais específica.
      if (/size\s*limit/i.test(e.message) || e.code === 4) truncado = true; else throw e;
    }
    const users = entries.map(e => ({
      username: firstValue(e[login]).toLowerCase(),
      name: firstValue(e[nameAttr]) || firstValue(e.cn) || firstValue(e[login]),
      email: firstValue(e[emailAttr]),
      dn: e.dn,
      memberOf: asArray(e.memberOf).map(String),
    })).filter(u => u.username);
    users.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return { users, truncado };
  } finally {
    await client.unbind().catch(() => {});
  }
}

// Testa só a conexão e a conta de serviço.
async function testConnection(cfg) {
  const client = makeClient(cfg);
  try {
    await startTlsIfNeeded(client, cfg);
    if (cfg.bind_dn) await client.bind(cfg.bind_dn, cfg.bind_password || '');
    await client.search(cfg.base_dn, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'] });
  } finally {
    await client.unbind().catch(() => {});
  }
}

// "CN=TI,OU=Grupos,DC=gacc,DC=local" -> "ti"
function cnOf(dn) {
  const m = /^\s*cn\s*=\s*((?:\\,|[^,])+)/i.exec(dn);
  return m ? m[1].replace(/\\,/g, ',').trim().toLowerCase() : '';
}

// Um grupo do sistema casa com o usuário se algum valor mapeado (DN completo
// ou só o nome/CN do grupo no AD) bater com um dos grupos em memberOf.
function matchesGroup(memberOf, mappedValues) {
  const dns = memberOf.map(d => d.trim().toLowerCase());
  const cns = memberOf.map(cnOf);
  return mappedValues.some(v => {
    const val = v.trim().toLowerCase();
    if (!val) return false;
    return val.includes('=') ? dns.includes(val) : cns.includes(val);
  });
}

module.exports = { authenticate, findUser, searchUsers, testConnection, matchesGroup, escapeFilter };
