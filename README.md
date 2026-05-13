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

