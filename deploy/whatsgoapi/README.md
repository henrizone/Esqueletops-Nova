# Serviço de figurinhas com áudio (whatsgoapi)

Serviço auxiliar usado **somente** pelo comando `/audio` do WhatsApp. É a
[whatsgoapi](https://github.com/moothz/whatsgoapi) (API REST extraída do bot
[ravena-ai](https://github.com/moothz/ravena-ai), feita sobre a biblioteca
whatsmeow), compilada em commits fixos.

O número entra nele como **mais um aparelho conectado**. Links, `/fig` e todo o
resto continuam pela Evolution API; se este serviço cair, só o som deixa de
funcionar.

> O formato da figurinha com áudio não é documentado pelo WhatsApp (engenharia
> reversa da comunidade). Pode parar de funcionar com atualizações do app.

## 1. Banco de dados

Crie um banco PostgreSQL vazio para o serviço (pode ser no mesmo servidor
Postgres do bot, mas com **outro nome de banco**, por exemplo `whatsgo`).

## 2. App no Easypanel

1. Crie um App novo (ex.: `figurinhas`).
2. Em **Source → Dockerfile**, cole o conteúdo de [`Dockerfile`](./Dockerfile).
3. Em **Environment**:

```env
GLOBAL_API_KEY=<gere uma chave longa e aleatória>
POSTGRES_HOST=<host do postgres>
POSTGRES_PORT=5432
POSTGRES_USER=<usuário>
POSTGRES_PASSWORD=<senha>
POSTGRES_DB=whatsgo
# Guarda a sessão do WhatsApp no Postgres (sem isso ela fica em arquivo dentro
# do container e o número desconecta a cada deploy).
POSTGRES_AUTH_DB=postgres://<usuário>:<senha>@<host do postgres>:5432/whatsgo?sslmode=disable
```

4. A porta do container é `8080`. **Não precisa de domínio público**: o bot
   acessa pela rede interna do Easypanel. Se criar um domínio mesmo assim,
   lembre que a `GLOBAL_API_KEY` dá controle total do número.
5. Faça o deploy. O primeiro build demora alguns minutos (compila em Go).

## 3. Variáveis no bot

```env
SOUND_STICKER_API_URL=http://<projeto>_figurinhas:8080
SOUND_STICKER_API_KEY=<a mesma GLOBAL_API_KEY>
# opcional, padrão "figurinhas"
SOUND_STICKER_INSTANCE=figurinhas
```

## 4. Conectar o número (QR code)

Depois de reiniciar o bot, procure no log a linha
`Figurinhas com áudio: serviço auxiliar configurado`. Ela traz o `pairingUrl`.
Abra esse link no navegador e, no celular, vá em **Aparelhos conectados →
Conectar um aparelho** e leia o código. A página mostra "Número conectado"
quando terminar.

O link contém um token de acesso: não compartilhe.

## Uso

`/audio` (ou `/fig audio`) em um vídeo com som, na legenda ou respondendo o
vídeo. Se o serviço estiver fora do ar, a figurinha sai sem som e o bot avisa.
