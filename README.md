# Esqueletops • Nova

Bot multifunções para Telegram desenvolvido em **TypeScript**, utilizando **PostgreSQL**, **Redis**, **grammY**, **yt-dlp**, **FFmpeg** e **Sharp**.

Este projeto foi reutilizado e reconstruído a partir do projeto original [SmudgeLord](https://github.com/ruizlenato/SmudgeLord), criado por **ruizlenato**.

A versão **Esqueletops • Nova** mantém a proposta de um bot multifunções, mas passou por uma reescrita completa da arquitetura, remoção de funcionalidades específicas e modernização da infraestrutura para uso em ambientes como Docker e EasyPanel.

## Origem do projeto

Projeto original:

* Repositório: [ruizlenato/SmudgeLord](https://github.com/ruizlenato/SmudgeLord)
* Linguagem original: Go
* Banco de dados original: SQLite
* Licença: GPL-3.0

O código original serviu como referência para os recursos, comandos e comportamento geral do bot.

Esta versão não é apenas uma alteração visual ou troca de nome. O projeto foi reestruturado e reescrito em TypeScript, com uma nova organização de código, banco de dados, cache, processamento de mídia e configuração de produção.

## Principais alterações realizadas

### Reescrita completa em TypeScript

O projeto original, escrito em Go, foi substituído por uma nova implementação em:

* TypeScript.
* Node.js.
* grammY.
* Fastify.
* PostgreSQL.
* Redis.

A nova estrutura separa comandos, serviços, banco de dados, cache, downloads, conversões e configurações.

### Remoção completa do Last.fm

Toda a integração com Last.fm foi removida, incluindo:

* Cadastro de usuário do Last.fm.
* Música atual.
* Artistas e álbuns recentes.
* Colagens.
* Consultas de scrobbles.
* Variáveis de ambiente.
* Tabelas e campos relacionados.
* Comandos e textos de ajuda.

O **Esqueletops • Nova** não possui dependência ou funcionalidade relacionada ao Last.fm.

### Migração de SQLite para PostgreSQL

O banco SQLite local foi substituído por PostgreSQL.

O PostgreSQL armazena:

* Usuários conhecidos pelo bot.
* Grupos e conversas.
* Configurações individuais de cada grupo.
* Status AFK.
* Comandos desativados.
* Pacotes de figurinhas.
* Preferências dos usuários.
* Informações administrativas.

As migrações são executadas automaticamente na inicialização e utilizam advisory lock para evitar que duas instâncias alterem o banco ao mesmo tempo.

### Redis configurável

O cache local e o endereço fixo de Redis foram substituídos por uma conexão configurável através de `REDIS_URL`.

O Redis é usado para:

* Cache de mídias.
* Cache de `file_id` do Telegram.
* Cooldown de downloads.
* Locks por URL.
* Prevenção de processamento duplicado.
* Estados temporários de botões e confirmações.
* Controle da fila de downloads.

### Novo sistema de downloads

A camada de downloads foi reconstruída utilizando `yt-dlp`, FFmpeg, FFprobe e Sharp.

O bot pode detectar links automaticamente e processar conteúdos de:

* Instagram.
* TikTok.
* X/Twitter.
* Reddit.
* Threads.
* Bluesky.
* Pinterest.
* Substack.
* Xiaohongshu/Rednote.
* YouTube.

Também pode aceitar domínios extras configurados pelo administrador.

O sistema oferece:

* Download automático em grupos e conversas privadas.
* Comandos `/dl`, `/sdl` e `/ytdl`.
* Download de galerias.
* Envio de fotos, vídeos, áudios e documentos.
* Conversão automática de formatos.
* Compressão de arquivos.
* Controle de tamanho e duração.
* Fila com concorrência configurável.
* Cooldown por usuário.
* Cache de mídias já enviadas.
* Cookies opcionais para o yt-dlp.
* Legendas configuráveis.
* Exclusão opcional da mensagem original.

### Sistema de figurinhas reconstruído

Os comandos de figurinhas foram preservados e adaptados para a nova arquitetura.

Recursos disponíveis:

* Criação de pacotes estáticos.
* Criação de pacotes animados.
* Criação de pacotes de vídeo.
* Conversão de imagens para WebP.
* Conversão de vídeos e animações para WebM.
* Seleção do pacote padrão.
* Listagem de pacotes.
* Exclusão de pacotes.
* Exportação da figurinha como arquivo.
* Criação automática de um novo pacote quando o atual estiver cheio.

### Correção das permissões administrativas

No projeto original, algumas configurações eram apresentadas como exclusivas para administradores, mas não possuíam uma verificação completa de permissão.

Na nova versão, as alterações administrativas verificam se o usuário é:

* Administrador do grupo.
* Criador do grupo.
* Proprietário configurado em `OWNER_IDS`.

Isso se aplica a:

* `/config`.
* Ativação e desativação de downloads.
* Alteração de legendas.
* Exclusão da mensagem original.
* Configuração do idioma.
* `/disable`.
* `/enable`.

### Configuração por variáveis de ambiente

Tokens, URLs, IDs e limites não ficam escritos diretamente no código.

As principais configurações são controladas por variáveis de ambiente, incluindo:

* Token do Telegram.
* Proprietários.
* PostgreSQL.
* Redis.
* Canal de logs.
* Limites de upload.
* Concorrência de downloads.
* Cookies.
* Webhook.
* Idioma.
* Domínios permitidos.
* Provedor de tradução.

### Preparação para Docker e EasyPanel

O projeto inclui:

* `Dockerfile`.
* `.dockerignore`.
* `docker-compose.yml`.
* `.env.example`.
* Healthcheck.
* Endpoint `/health`.
* Endpoint `/ready`.
* Suporte a polling.
* Suporte a webhook.
* Guia específico para EasyPanel.

O App não precisa de volume persistente, pois os dados ficam armazenados no PostgreSQL e no Redis.

## Recursos

### Downloads de mídia

* Detecta links automaticamente em grupos e conversas privadas.
* Funciona também por `/dl`, `/sdl` e `/ytdl`.
* Suporta os principais sites compatíveis com yt-dlp.
* Baixa galerias com múltiplos itens.
* Envia fotos, vídeos, áudios ou documentos.
* Gera legenda com título, autor, descrição e link original.
* Converte e comprime mídias com FFmpeg e Sharp.
* Reaproveita arquivos já enviados usando o `file_id` do Telegram.
* Usa fila, cooldown e lock por URL.
* Pode apagar a mensagem original quando autorizado.
* Aceita cookies opcionais para conteúdos que exigem sessão.

### Figurinhas

* `/kang [emoji]`: adiciona a mídia respondida ao pacote padrão.
* `/newpack [título]`: cria um pacote usando a mídia respondida.
* `/mypacks`: lista os pacotes do usuário.
* `/switch`: altera o pacote padrão.
* `/delpack`: exclui um pacote criado pelo bot.
* `/getsticker`: exporta uma figurinha como arquivo.
* Suporta pacotes estáticos, animados e de vídeo.
* Cria automaticamente um novo pacote quando necessário.

### AFK

* `/afk [motivo]`.
* `brb [motivo]`.
* Avisa quando um usuário AFK é mencionado.
* Avisa quando alguém responde a um usuário AFK.
* Mostra o motivo e o tempo de ausência.
* Remove o AFK automaticamente quando o usuário volta.

### Utilidades

* `/weather cidade`.
* `/clima cidade`.
* `/tr idioma texto`.
* `/translate`.
* `/slap`.
* `/id`.
* `/ping`.
* Modo inline.

O clima utiliza Open-Meteo.

A tradução pode utilizar Google ou LibreTranslate, dependendo da configuração.

### Administração de grupos

* `/config`.
* Ativar ou desativar download automático.
* Ativar ou desativar legendas.
* Ativar ou desativar mensagens de erro.
* Ativar ou desativar exclusão da mensagem original.
* Alterar o idioma do grupo.
* `/disable comando`.
* `/enable comando`.
* `/disabled`.
* `/disableable`.

### Proprietário

Um ou mais proprietários podem ser configurados em `OWNER_IDS`.

Comandos disponíveis:

* `/stats`: exibe quantidade de usuários e grupos conhecidos.
* `/announce users mensagem`.
* `/announce groups mensagem`.
* `/announce all mensagem`.

Os anúncios possuem prévia e confirmação antes do envio.

Também é possível configurar um canal privado para logs e erros utilizando `LOG_CHANNEL_ID`.

## Arquitetura

```text
Telegram
   │
   ▼
grammY / TypeScript
   ├── PostgreSQL
   │      Usuários, grupos, configurações, AFK e pacotes
   │
   ├── Redis
   │      Cache, cooldowns, locks e estados temporários
   │
   ├── yt-dlp
   │      Extração e download de mídias
   │
   ├── FFmpeg e FFprobe
   │      Conversão e processamento de áudio e vídeo
   │
   ├── Sharp
   │      Conversão e processamento de imagens
   │
   └── Fastify
          Healthcheck, readiness e webhook opcional
```

## Requisitos

Ao utilizar Docker ou EasyPanel, as dependências são instaladas automaticamente pelo `Dockerfile`.

Para execução local sem Docker:

* Node.js 24 ou superior.
* PostgreSQL.
* Redis.
* FFmpeg.
* FFprobe.
* yt-dlp.

## Instalação local com Docker Compose

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

Preencha pelo menos:

```env
TELEGRAM_TOKEN=
OWNER_IDS=
DATABASE_URL=
REDIS_URL=
```

Ajuste as senhas do PostgreSQL e do Redis para que coincidam entre `.env` e `docker-compose.yml`.

Inicie os serviços:

```bash
docker compose up --build -d
```

Acompanhe os logs:

```bash
docker compose logs -f bot
```

## Desenvolvimento

Instale as dependências:

```bash
npm install
```

Crie o arquivo de ambiente:

```bash
cp .env.example .env
```

Inicie em modo de desenvolvimento:

```bash
npm run dev
```

Valide o projeto:

```bash
npm run typecheck
npm run build
npm test
```

## Variáveis obrigatórias

| Variável         | Descrição                                              |
| ---------------- | ------------------------------------------------------ |
| `TELEGRAM_TOKEN` | Token fornecido pelo BotFather                         |
| `OWNER_IDS`      | IDs numéricos dos proprietários, separados por vírgula |
| `DATABASE_URL`   | URL de conexão com PostgreSQL                          |
| `REDIS_URL`      | URL de conexão com Redis                               |

## Variáveis importantes

| Variável                     |               Padrão | Uso                                       |
| ---------------------------- | -------------------: | ----------------------------------------- |
| `BOT_DISPLAY_NAME`           | `Esqueletops • Nova` | Nome exibido pelo bot                     |
| `LOG_CHANNEL_ID`             |                vazio | Canal privado para logs e erros           |
| `RUN_MODE`                   |            `polling` | Define `polling` ou `webhook`             |
| `MAX_UPLOAD_MB`              |                 `49` | Limite utilizado antes do envio           |
| `MAX_MEDIA_ITEMS`            |                 `10` | Máximo de itens processados por link      |
| `MAX_AUTO_DURATION_SECONDS`  |                `180` | Duração máxima no download automático     |
| `MAX_FORCE_DURATION_SECONDS` |               `1800` | Duração máxima por comando                |
| `DOWNLOAD_CONCURRENCY`       |                  `2` | Quantidade de downloads simultâneos       |
| `DOWNLOAD_COOLDOWN_SECONDS`  |                  `8` | Intervalo de uso por usuário              |
| `MEDIA_CACHE_TTL_SECONDS`    |             `604800` | Duração do cache de mídia                 |
| `YTDLP_COOKIES_B64`          |                vazio | Cookies Netscape codificados em Base64    |
| `ALLOW_GENERIC_URLS`         |              `false` | Permite enviar qualquer domínio ao yt-dlp |
| `MEDIA_ALLOWED_DOMAINS`      |                vazio | Domínios adicionais separados por vírgula |
| `TRANSLATE_PROVIDER`         |             `google` | Provedor de tradução                      |

A lista completa está documentada em `.env.example`.

## EasyPanel

O guia completo de instalação está disponível em:

```text
DEPLOY-EASYPANEL.md
```

Estrutura recomendada:

* Um serviço PostgreSQL.
* Um serviço Redis.
* Um serviço App utilizando o `Dockerfile`.
* Uma única réplica.
* `RUN_MODE=polling`.
* Sem domínio no modo polling.
* Sem volume persistente no App.

As URLs internas fornecidas pelo EasyPanel devem ser usadas em:

```env
DATABASE_URL=
REDIS_URL=
```

## Permissões no Telegram

Para detectar links, mensagens AFK e comandos sem barra em grupos, desative o Privacy Mode pelo BotFather.

Para utilizar a opção de apagar a mensagem original, o bot precisa ser administrador do grupo com permissão para excluir mensagens.

As demais funções não exigem necessariamente que o bot seja administrador, embora algumas consultas de membros possam funcionar melhor quando ele possui permissões adicionais.

## Segurança e limites

* Não publique o arquivo `.env`.
* Não publique o token do Telegram.
* Não publique as senhas do PostgreSQL ou Redis.
* Não publique cookies do yt-dlp.
* Utilize PostgreSQL e Redis pela rede interna do EasyPanel.
* Mantenha apenas uma réplica ao utilizar polling.
* Atualize o yt-dlp quando alguma plataforma alterar seus mecanismos.
* Conteúdos privados, pagos, protegidos por DRM ou sem acesso da conta não são contornados.
* Respeite os direitos autorais, os termos das plataformas e a legislação aplicável.

## Créditos

O **Esqueletops • Nova** foi reutilizado e reconstruído com base no projeto:

* [SmudgeLord](https://github.com/ruizlenato/SmudgeLord), de **ruizlenato**.

Agradecimentos ao autor original pela disponibilização do código e da ideia sob licença livre.

As funcionalidades, arquitetura e implementação atuais foram amplamente modificadas, incluindo a reescrita em TypeScript, a remoção do Last.fm e a migração para PostgreSQL e Redis.

## Licença

Este projeto é distribuído sob a licença **GPL-3.0-only**, seguindo a licença do projeto original.

Consulte:

* `LICENSE`.
* `NOTICE.md`.

Ao reutilizar, modificar ou redistribuir este projeto, preserve os avisos de licença e os créditos do projeto original.
