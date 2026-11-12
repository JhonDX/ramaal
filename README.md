# 📞 Sistema de Lista de Ramais — GACC-BA
Sistema completo de diretório telefônico com painel admin e integração 3CX.

---

## 🚀 Como iniciar

### Pré-requisitos
- Docker instalado
- Docker Compose instalado

### 1. Configure o 3CX (opcional)
Edite o arquivo `docker-compose.yml` e preencha os dados da sua central:

```yaml
environment:
  - TCX_HOST=sua3cx.suaempresa.com.br   # domínio da central 3CX
  - TCX_PORT=443                         # porta HTTPS (padrão 443)
  - TCX_USER=admin                       # usuário administrador 3CX
  - TCX_PASS=SuaSenha123                 # senha do usuário
```

> Se não preencher, o sistema funciona normalmente sem integração 3CX.

### 2. Suba os containers

```bash
docker compose up -d --build
```

Aguarde ~30 segundos na primeira vez (compilação do SQLite nativo).

### 3. Acesse no navegador

| Página              | URL                          |
|---------------------|------------------------------|
| Lista de Ramais     | http://localhost              |
| Painel Admin        | http://localhost/admin.html   |

### 4. Login padrão

| Campo   | Valor      |
|---------|------------|
| Usuário | `admin`    |
| Senha   | `admin123` |

> ⚠️ Altere a senha padrão após o primeiro acesso!

---

## 👥 Grupos de permissão

O acesso ao painel admin é controlado por **grupos de permissão** (menu *Grupos de Permissão*). Cada usuário pode estar em um ou mais grupos e recebe a soma das permissões deles:

| Permissão                     | O que libera                                              |
|-------------------------------|-----------------------------------------------------------|
| Gerenciar ramais              | Criar, editar, ordenar e excluir ramais                   |
| Gerenciar usuários            | Criar, editar e excluir usuários e vinculá-los a grupos   |
| Gerenciar grupos de permissão | Criar e editar grupos e o mapeamento com grupos do LDAP   |
| Configurações do sistema      | Configurar a integração LDAP / Active Directory           |

- O grupo **Administradores** já vem criado, tem sempre todas as permissões e não pode ser excluído. Usuários que já existiam antes desta versão entram nele automaticamente.
- O sistema não deixa salvar uma alteração que deixe ninguém ativo com permissão de gerenciar usuários e grupos.
- Quem não está em nenhum grupo não consegue entrar no painel.

---

## 🔐 Login via LDAP / Active Directory

Tudo é configurado pelo próprio sistema, em **Integração LDAP** (precisa da permissão *Configurações do sistema*). Não é preciso mexer no `docker-compose.yml`.

1. Preencha o servidor (`ldap://dc01.gacc.local:389` ou `ldaps://dc01.gacc.local:636`), o usuário de serviço (Bind DN) e a senha dele, a Base DN e o filtro de usuário.
   - Active Directory: `(sAMAccountName={{username}})`
   - OpenLDAP: `(uid={{username}})`
2. Clique em **Testar conexão** e depois teste um usuário real em **Testar um usuário**: o sistema mostra o DN, os grupos do AD e em quais grupos do sistema ele cairia.
3. Em **Grupos de Permissão**, edite cada grupo e informe os grupos do AD vinculados a ele (DN completo, como `CN=TI,OU=Grupos,DC=gacc,DC=local`, ou só o nome `TI`).
4. Ative o login LDAP e salve.

Como funciona o login:

- Usuários **locais** (como o `admin`) continuam entrando com a senha do sistema, mesmo com o LDAP ligado. Mantenha pelo menos um administrador local como acesso de emergência.
- Os demais são validados no LDAP. No primeiro login o usuário é criado automaticamente, com nome e e-mail vindos do AD.
- A cada login os grupos mapeados são sincronizados com o `memberOf` do AD: quem sai do grupo no AD perde o grupo no sistema. Grupos sem mapeamento LDAP são mantidos como o admin marcou.
- Quem não cai em nenhum grupo usa o **grupo padrão** (se configurado); sem ele, o login é recusado.
- Também dá para pré-cadastrar um usuário LDAP em *Usuários > Novo Usuário > Usuário da rede* e já deixá-lo nos grupos antes do primeiro acesso.
- A senha do usuário de serviço fica salva no banco e nunca é devolvida para o navegador.

> Grupos aninhados do AD (grupo dentro de grupo) não são resolvidos: o usuário precisa ser membro direto do grupo mapeado.

---

## 🔌 Integração 3CX

### Funcionalidades disponíveis

| Recurso                   | Descrição                                                     |
|---------------------------|---------------------------------------------------------------|
| **Status em tempo real**  | Ícone colorido em cada ramal: disponível / ocupado / offline  |
| **Filtro por status**     | Filtre a lista por disponibilidade dos ramais                 |
| **Click-to-call**         | Clique no botão 📞 para ligar diretamente para o ramal       |
| **Histórico de chamadas** | Veja chamadas recentes por ramal (entrada, saída, perdidas)  |
| **Softphone WebRTC**      | Faça chamadas direto no navegador, sem telefone físico        |

### Usando o Softphone

1. Clique em **Softphone** no topo da página
2. Informe seu ramal, senha SIP e o endereço do servidor 3CX
3. Clique em **Conectar ao 3CX**
4. Após conectado, clique em 📞 em qualquer ramal para ligar

### APIs 3CX utilizadas

| Endpoint                        | Finalidade                      |
|---------------------------------|---------------------------------|
| `POST /connect/token`           | Autenticação OAuth              |
| `GET  /xapi/v1/ExtensionStatus` | Status/presença dos ramais      |
| `POST /xapi/v1/MakeCall`        | Originar chamada (server-side)  |
| `GET  /xapi/v1/ActiveCalls/CallLog` | Histórico de chamadas       |
| WebSocket `wss://{host}/ws`     | SIP sobre WebRTC (softphone)    |

> **Requisito 3CX:** versão 16 ou superior. O usuário configurado precisa ter permissão de API e acesso ao log de chamadas.

---

## 🛑 Parar / reiniciar

```bash
# Parar sem perder dados
docker compose down

# Parar e apagar todos os dados
docker compose down -v

# Rebuild completo
docker compose up -d --build
```

---

## 📁 Estrutura do Projeto

```
ramal-app/
├── backend/
│   ├── server.js          # API REST (Express + SQLite + 3CX)
│   ├── ldap.js            # Autenticação LDAP / Active Directory
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   ├── public/
│   │   ├── index.html     # Lista pública + Softphone WebRTC
│   │   └── admin.html     # Painel administrativo
│   └── Dockerfile
├── nginx/
│   └── nginx.conf         # Reverse proxy
├── docker-compose.yml
└── README.md
```

---

## 🔧 Alterar a porta do sistema

No `docker-compose.yml`, mude:
```yaml
ports:
  - "8080:80"   # sistema acessível em http://localhost:8080
```

---

## 🛡️ Segurança recomendada

- Troque o `JWT_SECRET` no `docker-compose.yml` por um valor aleatório longo
- Troque a senha padrão `admin123` no primeiro acesso
- Em produção, use HTTPS com certificado SSL (Nginx + Let's Encrypt)

