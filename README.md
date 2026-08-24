# Mira — Realtime 2.1 + cérebro Codex persistente

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
        │                    │
        │                    └── turn normalizado ── Zep User Graph
        │                                           ├── thread por Space
        │                                           └── contexto histórico dinâmico ──┐
        │                                                                              ↓
        └── consult_codex ── servidor Node ── codex app-server --stdio
                                                │
                                                ├── thread principal durável
                                                ├── lógica e memória contextual
                                                ├── leitura local em read-only
                                                └── fork efémero de pesquisa web
```

Mira usa o `gpt-realtime-2.1` para a conversa de baixa latência. Quando
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
- decide silenciosamente, através de uma resposta textual out-of-band do próprio
  `gpt-realtime-2.1`, se cada turno de voz é dirigido à Mira; decisões ambíguas,
  inválidas ou com erro resultam em silêncio;
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
- guarda decisões `RESPOND`/`IGNORE`, latência, estado/causa terminal, consumo real
  de tokens e, quando disponível, a transcrição associada em
  `data/response-gates.jsonl`, sem guardar áudio;
- guarda todos os pedidos e respostas do Luna, com duração, modelo, reasoning e
  prompt técnico, em `data/codex-consults.jsonl`;
- executa pesquisa num fork efémero, guarda o resultado em `data/research.jsonl`
  e devolve-o imediatamente ao Live; a sincronização com a thread principal
  continua em segundo plano sem atrasar a resposta de voz;
- mantém o OAuth ChatGPT no broker local, nunca no código público do browser.
- recebe as legendas finais do live chat de um X Space e envia imediatamente
  `@handle + texto` ao contexto do Realtime, sem disparar uma resposta;
- guarda essas legendas em `data/xspace-<room-id>.jsonl`, com proveniência literal.
- envia apenas turns finalizados para o Zep Cloud: owner como `user`, Mira como
  `assistant` e participantes externos como `norole`, sempre com identidade X
  estruturada quando existe;
- mantém uma thread Zep determinística por Space e um único User Graph entre Spaces;
- recupera um Context Block antes de `RESPOND`, com timeout e fallback fail-open, e
  substitui o bloco Realtime anterior em vez de o acumular;
- ingere turns relevantes mesmo quando o gate decide `IGNORE`.

## Requisitos

- Node.js 22 ou posterior;
- Chrome/Chromium com acesso ao microfone;
- uma subscrição ChatGPT compatível;
- OpenClaw autenticado uma vez neste projeto.
- Codex CLI autenticado pela conta usada no Codex app.
- cookies de uma sessão X válida para ativar a integração opcional com Spaces.
- um projeto Zep Cloud e `ZEP_API_KEY` apenas se quiser ativar memória permanente.

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

## Memória permanente Zep

Crie um `.env` local, que já está ignorado pelo Git:

```bash
cp .env.example .env
```

Preencha apenas localmente:

```text
ZEP_API_KEY=...
ZEP_USER_ID=mira-main
ZEP_ENABLED=true
ZEP_CONTEXT_TIMEOUT_MS=350
ZEP_CONTEXT_MAX_CHARS=12000
ZEP_OWNER_CAPTION_WAIT_MS=1200
```

Sem chave ou sem User ID, a aplicação continua normalmente e regista uma única
mensagem clara de memória desativada. A chave nunca é devolvida pela API local nem
incluída nos logs. `ZEP_CONTEXT_TIMEOUT_MS` limita retrieval no caminho de voz;
`ZEP_CONTEXT_MAX_CHARS` limita o bloco que entra no Realtime.

O listener lê automaticamente o owner em `creator_results`/`participants.admins`
da metadata do Space, por handle ou Twitter ID estruturado. `X_OWNER_HANDLE` é apenas
um override para protocolos X que deixem de fornecer essa metadata. `X_SELF_HANDLE`
identifica a conta da Mira e evita reingerir a própria fala através das captions X.

Uma fala do owner pode aparecer simultaneamente na transcrição Realtime e nas
captions X. A caption X é a fonte autoritativa. O final Realtime espera no máximo
`ZEP_OWNER_CAPTION_WAIT_MS`; se a caption não chegar ou o listener falhar, é ingerido
como fallback `User`. `turnId`, UUID determinístico, fingerprint e uma janela de
correlação impedem que reconnect, replay ou uma caption tardia criem uma segunda
memória.

### Ontology

O arranque nunca altera a ontology cloud. Para inspecionar a ontology efetiva:

```bash
npm run zep:ontology
```

O comando mostra tipos atuais, tipos esperados e diferenças. Só depois de rever o
resultado, aplique conscientemente a definição completa orientada a debate:

```bash
npm run zep:ontology:apply
```

`setOntology` substitui os tipos customizados do alvo; por isso o script envia sempre
a definição completa e limita a alteração ao `ZEP_USER_ID`. Os tipos default `User`
e `Assistant` permanecem ativos.

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

No dashboard Zep, abra o User definido em `ZEP_USER_ID`. Confirme uma thread
`mira-<space>-<hash>` por Space, episódios separados por turn, mensagens `assistant`
com nome `Mira`, externos `norole` com `@handle` e timestamps originais. No grafo,
confirme que posições antigas permanecem históricas quando uma posição posterior as
invalida ou substitui.

## Validar

```bash
npm run check
```

Os testes verificam a fronteira HTTP local, o response gate e a sua máquina de
estados, as escolhas fixas de
`gpt-realtime-2.1` e `gpt-5.6-luna`/`low`, a ferramenta permitida, as vozes, o
isolamento do token OAuth, o diário JSONL, a thread durável, o fork de pesquisa,
normalização/identidade Zep, roles multiparty, idempotência, ordenação por turn ID,
fallback do owner, timeout/falha e substituição do contexto dinâmico.
A prova final do áudio continua a ser uma chamada real, porque o acesso Realtime
depende da conta e do backend atual.

## Persistência e segurança

`data/codex-state.json` guarda o identificador da thread e a última linha do
diário sincronizada. `data/` está ignorado pelo Git e pode ser apagado para
reiniciar a memória deste agente. A thread principal e os turnos Codex usam
`sandbox: read-only` e `approvalPolicy: never`: esta versão consulta e analisa,
mas não altera ficheiros nem executa ações externas em nome do utilizador.

O botão **Limpar** remove apenas a transcrição visível. Não apaga o diário nem a
thread persistente, nem o User Graph do Zep.

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
- a correlação de duas transcrições diferentes da mesma fala usa proximidade temporal
  e overlap textual; métricas reais de X Spaces devem orientar a afinação da janela;
- o grafo Zep é atualizado assincronamente, portanto o Context Block do turno atual
  serve sobretudo memória anterior e não depende de read-after-write imediato;
- não inclui as restantes automações completas do CODEXVOICE.
