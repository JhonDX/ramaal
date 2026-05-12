# 📞 Sistema de Lista de Ramais — GACC-BA

Sistema completo de diretório telefônico institucional com painel administrativo, construído com Node.js, SQLite e Docker.

---

## 🚀 Como iniciar

### Pré-requisitos
- [Docker](https://docs.docker.com/get-docker/) instalado
- [Docker Compose](https://docs.docker.com/compose/install/) instalado

### 1. Suba os containers

```bash
docker compose up -d --build
```

### 2. Acesse no navegador

| Página | URL |
|---|---|
| Lista Pública de Ramais | http://localhost |
| Painel Admin | http://localhost/admin.html |

### 3. Login padrão do Admin

| Campo | Valor |
|---|---|
| Usuário | `admin` |
| Senha | `admin123` |

> ⚠️ **Altere a senha padrão após o primeiro acesso!**

---

## 🛑 Para parar os containers

```bash
docker compose down
```

## 🗑️ Para remover tudo (incluindo dados)

```bash
docker compose down -v
```

---

## 📁 Estrutura do Projeto

```
ramal-app/
├── backend/
│   ├── server.js        # API REST (Express + SQLite)
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   ├── public/
│   │   ├── index.html   # Lista pública de ramais
│   │   └── admin.html   # Painel administrativo
│   └── Dockerfile
├── nginx/
│   └── nginx.conf       # Reverse proxy
├── docker-compose.yml
└── README.md
```

---

## 🔧 Funcionalidades

### Lista Pública (`/`)
- ✅ Visualização em tabela ou cards
- ✅ Busca por nome, cargo, ramal ou e-mail
- ✅ Filtro por setor
- ✅ Agrupamento por setor
- ✅ Link direto para envio de e-mail

### Painel Admin (`/admin.html`)
- ✅ Login seguro com JWT
- ✅ Dashboard com estatísticas
- ✅ CRUD completo de ramais (criar, editar, excluir)
- ✅ Ativar/desativar ramal sem excluir
- ✅ CRUD de usuários administradores
- ✅ Dados persistidos em SQLite via volume Docker

---

## ⚙️ Configurações avançadas

### Alterar a porta
No `docker-compose.yml`, mude a linha:
```yaml
ports:
  - "8080:80"   # Agora acessa em http://localhost:8080
```

### Alterar o JWT Secret
No `docker-compose.yml`:
```yaml
environment:
  - JWT_SECRET=seu-segredo-aqui
```

---

## 🏗️ Tecnologias utilizadas

- **Backend:** Node.js, Express, better-sqlite3, bcryptjs, jsonwebtoken
- **Frontend:** HTML5, CSS3, JavaScript puro
- **Proxy:** Nginx (Alpine)
- **Banco de dados:** SQLite (persistido via Docker Volume)
- **Containerização:** Docker + Docker Compose
