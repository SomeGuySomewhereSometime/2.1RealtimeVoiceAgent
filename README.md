# Codex 2.1 Voice — Realtime + cérebro Codex persistente

Aplicação local speech-to-speech inspirada nos projetos `2.5LiveVoiceAgent` e
`3.1LiveVoiceAgent`, mas usando o modelo **`gpt-realtime-2.1`** por WebRTC.
Segue o mesmo desenho do Browser Talk do OpenClaw: a subscrição ChatGPT é
autenticada por OAuth no Gateway local e não é necessária uma
`OPENAI_API_KEY`.

## Arquitetura

```text
browser (microfone + áudio remoto)
        │
        ├── WebRTC ── OpenClaw Quicksilver ── gpt-realtime-2.1
        │                                      voz e turn-taking
        │                              ↑
        ├── X live chat ── legenda final @handle + texto
        │
        └── consult_codex ── servidor Node ── codex app-server --stdio
                                                │
                                                ├── thread principal durável
                                                ├── lógica e memória contextual
                                                ├── leitura local em read-only
                                                └── fork efémero de pesquisa web
```

O `gpt-realtime-2.1` continua responsável pela conversa de baixa latência. Quando
precisa de melhor lógica, memória, informação atual, ficheiros ou planeamento,
chama `consult_codex`. Todas essas consultas, incluindo pesquisa web, usam
explicitamente **`gpt-5.6-luna`** com reasoning **`low`**. O browser nunca recebe
o login nem o protocolo interno do Codex.

## O que faz

- conversa por microfone e recebe a resposta diretamente por WebRTC;
- mostra transcrições do utilizador e do assistente; a transcrição de entrada usa
  `gpt-4o-mini-transcribe` separadamente do entendimento direto do áudio pelo Realtime,
  sem fixar uma língua;
- usa `semantic_vad` com eagerness `medium` para tolerar hesitações e pausas curtas,
  mantendo a interrupção automática quando o utilizador volta a falar;
- aceita mensagens escritas durante a sessão;
- permite escolher reasoning baixo, médio ou alto antes de iniciar;
- permite escolher o microfone antes de iniciar e mudar a saída de áudio durante
  a conversa quando o browser suporta `setSinkId`;
- permite silenciar o microfone e terminar a conversa;
- mantém uma thread Codex durável e retoma-a depois de reiniciar a aplicação;
- fixa o cérebro persistente e a pesquisa em `gpt-5.6-luna` com reasoning `low`;
- permite ao Realtime delegar lógica, memória, pesquisa, ficheiros e planeamento;
- informa o Live da data local em cada sessão e a Luna da data em cada consulta;
- obriga a consulta ao Luna para factos atuais/recentes, correções, ambiguidades
  relevantes e perguntas com “hoje”, “atual”, “último” ou “mais recente”;
- mantém o microfone e a interface ativos enquanto uma consulta está pendente;
- guarda a conversa literal em `data/conversation.jsonl`;
- guarda todos os pedidos e respostas do Luna, com duração, modelo, reasoning e
  prompt técnico, em `data/codex-consults.jsonl`;
- executa pesquisa num fork efémero, guarda o resultado em `data/research.jsonl`
  e devolve-o imediatamente ao Live; a sincronização com a thread principal
  continua em segundo plano sem atrasar a resposta de voz;
- mantém o OAuth ChatGPT no broker local, nunca no código público do browser.
- recebe as legendas finais do live chat de um X Space e envia imediatamente
  `@handle + texto` ao contexto do Realtime, sem disparar uma resposta;
- guarda essas legendas em `data/xspace-<room-id>.jsonl`, com proveniência literal.

## Requisitos

- Node.js 22 ou posterior;
- Chrome/Chromium com acesso ao microfone;
- uma subscrição ChatGPT compatível;
- OpenClaw autenticado uma vez neste projeto.
- Codex CLI autenticado pela conta usada no Codex app.
- cookies de uma sessão X válida para ativar a integração opcional com Spaces.

## Autenticar sem API key

```bash
npm install
npm run auth
```

O segundo comando abre o login OAuth do OpenClaw e grava o perfil em
`.openclaw-state/`, que está ignorado pelo Git. Este login é separado de
`~/.codex`; nenhum token é enviado ao browser.

Confirme também o login do cérebro Codex:

```bash
codex login status
```

Não é usada uma `OPENAI_API_KEY`: o Realtime usa o OAuth do OpenClaw e o
app-server reutiliza o login local do Codex.

## X Spaces: instalar e ligar

Instale uma vez as dependências do listener não oficial:

```bash
cd /home/sauron/Documentos/ChatGPT/2.1RealtimeVoiceAgent
npm run xspace:install
```

Por omissão, o listener lê os cookies de
`~/.config/kika/twitter.cookies`. Pode indicar outro ficheiro através de
`X_COOKIES_FILE`. Depois de iniciar a aplicação, cole na interface o link ou o
ID do Space e carregue em **Ligar**. Em alternativa, defina
`X_SPACE_ROOM_ID` antes de `npm start`.

O listener não calcula pausas, não compara timestamps e não junta intervenções.
O próprio X decide quando entrega um segmento final, normalmente numa pausa,
no fim da fala ou ao atingir o limite interno. Nesse instante a aplicação envia
ao Realtime uma mensagem de sistema silenciosa no formato
`[XCAP] speaker=@handle ... text_json="..."`. Isto atualiza o contexto, mas não
emite `response.create`; o agente só usa a informação na resposta seguinte que
já fosse pertinente.

## Executar

```bash
cd /home/sauron/Documentos/ChatGPT/2.1RealtimeVoiceAgent
npm start
```

Abra <http://127.0.0.1:3001>, escolha uma voz e carregue em **Iniciar
conversa**. Na primeira utilização, autorize o microfone. `PORT`, `HOST`,
`OPENCLAW_STATE_DIR` e `OPENCLAW_AGENT_DIR` são opcionais.

## Validar

```bash
npm run check
```

Os testes verificam a fronteira HTTP local, as escolhas fixas de
`gpt-realtime-2.1` e `gpt-5.6-luna`/`low`, a ferramenta permitida, as vozes, o
isolamento do token OAuth, o diário JSONL, a thread durável e o fork de pesquisa.
A prova final do áudio continua a ser uma chamada real, porque o acesso Realtime
depende da conta e do backend atual.

## Persistência e segurança

`data/codex-state.json` guarda o identificador da thread e a última linha do
diário sincronizada. `data/` está ignorado pelo Git e pode ser apagado para
reiniciar a memória deste agente. A thread principal e os turnos Codex usam
`sandbox: read-only` e `approvalPolicy: never`: esta versão consulta e analisa,
mas não altera ficheiros nem executa ações externas em nome do utilizador.

O botão **Limpar** remove apenas a transcrição visível. Não apaga o diário nem a
thread persistente.

O painel lateral **Luna → Live** mostra imediatamente quando um pedido foi
enviado e está a aguardar. Depois apresenta o pedido, a resposta do Luna, a
duração, a persistência em segundo plano e as respostas finais ditas pelo Live. O painel lê os diários
persistentes, portanto continua disponível depois de reiniciar a aplicação.

## Limites desta versão

- ações com efeitos externos e alterações de ficheiros permanecem desativadas;
- as consultas ao Codex usam quota Codex quando são chamadas;
- o protocolo `codex app-server` é experimental, pelo que a aplicação valida a
  integração contra a versão local instalada;
- a fonte X usa uma API não oficial e pode exigir ajustes se o protocolo interno
  do X mudar;
- não inclui as restantes automações completas do CODEXVOICE.
