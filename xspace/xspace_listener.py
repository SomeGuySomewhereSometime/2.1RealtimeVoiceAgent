#!/usr/bin/env python3
"""Emit final X Space captions with direct speaker identity as JSONL."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
import uuid
from collections import deque
from pathlib import Path
from urllib.parse import urlparse


def first_value(*values: object) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def json_object(value: object, orjson_module) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, bytes):
        value = value.decode(errors="ignore")
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = orjson_module.loads(value)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def is_true(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() not in {"", "0", "false", "no", "n", "nao"}


def decoded_message(message: object, orjson_module) -> tuple[dict, dict, dict, dict]:
    try:
        outer = orjson_module.loads(message)
    except Exception:
        return {}, {}, {}, {}
    if not isinstance(outer, dict):
        return {}, {}, {}, {}

    payload = json_object(outer.get("payload"), orjson_module)
    body = json_object(payload.get("body"), orjson_module)
    nested_body = json_object(body.get("body"), orjson_module)
    if nested_body:
        body = {key: value for key, value in body.items() if key != "body"}
        body = {**body, **nested_body}
    sender = json_object(payload.get("sender"), orjson_module)
    return outer, payload, body, sender


def parse_caption(message: object, orjson_module) -> dict | None:
    """Accept only a final caption whose text and @handle share one X event."""
    outer, _payload, body, sender = decoded_message(message, orjson_module)
    if outer.get("kind") != 1:
        return None

    text_keys = ("body", "text", "message", "transcript", "caption", "content")
    if not any(key in body for key in text_keys):
        return None
    final_value = next((body[key] for key in ("final", "is_final", "isFinal") if key in body), True)
    if not is_true(final_value):
        return None

    handle = first_value(
        body.get("username"), body.get("userName"), body.get("screenName"),
        body.get("twitter_screen_name"), sender.get("username"), sender.get("screen_name"),
    ).lstrip("@")[:15]
    text = first_value(*(body.get(key) for key in text_keys))[:1_500]
    if not handle or not text:
        return None

    display_name = first_value(
        body.get("displayName"), body.get("display_name"), body.get("name"),
        sender.get("display_name"), sender.get("name"),
    )[:80]
    chat_user_id = first_value(body.get("user_id"), body.get("userId"), sender.get("user_id"))[:80]
    twitter_id = first_value(body.get("twitter_id"), body.get("twitterId"), sender.get("twitter_id"))[:80]
    return {
        "type": "caption",
        "eventId": str(uuid.uuid4()),
        "handle": handle,
        "displayName": display_name,
        "chatUserId": chat_user_id,
        "twitterId": twitter_id,
        "text": text,
        "receivedAtMs": int(time.time() * 1000),
    }


async def listen_chat(chat: dict, orjson_module, websockets_module) -> None:
    endpoint = urlparse(str(chat["endpoint"])).hostname
    if not endpoint:
        raise RuntimeError("endpoint de live chat inválido")
    uri = f"wss://{endpoint}/chatapi/v1/chatnow"
    seen_messages: set[bytes] = set()
    seen_order: deque[bytes] = deque()
    async with websockets_module.connect(uri) as ws:
        await ws.send(orjson_module.dumps({
            "payload": orjson_module.dumps({"access_token": chat["access_token"]}).decode(),
            "kind": 3,
        }).decode())
        await ws.send(orjson_module.dumps({
            "payload": orjson_module.dumps({
                "body": orjson_module.dumps({"room": chat["room_id"]}).decode(),
                "kind": 1,
            }).decode(),
            "kind": 2,
        }).decode())
        print(json.dumps({"type": "status", "state": "connected"}), flush=True)
        while True:
            message = await ws.recv()
            raw = message if isinstance(message, bytes) else str(message).encode()
            fingerprint = hashlib.sha256(raw).digest()
            if fingerprint in seen_messages:
                continue
            if len(seen_order) >= 512:
                seen_messages.discard(seen_order.popleft())
            seen_order.append(fingerprint)
            seen_messages.add(fingerprint)
            event = parse_caption(message, orjson_module)
            if event:
                print(json.dumps(event, ensure_ascii=False), flush=True)


async def listen_chats(scraper, spaces: list[dict]) -> None:
    import orjson
    import websockets

    chats = await scraper._get_live_chats(scraper.session, spaces)
    if not chats:
        raise RuntimeError("live chat/transcrição do Space indisponível")
    await asyncio.gather(*(listen_chat(chat, orjson, websockets) for chat in chats))


def listen_once(room_id: str, cookies_file: Path) -> None:
    from twitter.scraper import Scraper

    if not cookies_file.is_file():
        raise RuntimeError("ficheiro de cookies X não encontrado")
    scraper = Scraper(save=False, debug=0, pbar=False, cookies=str(cookies_file))
    spaces = scraper.spaces(rooms=[room_id])
    if not spaces:
        raise RuntimeError("Space não encontrado")
    asyncio.run(listen_chats(scraper, spaces))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--room-id", required=True)
    parser.add_argument("--cookies-file", required=True)
    parser.add_argument("--reconnect-seconds", type=float, default=3.0)
    args = parser.parse_args()
    cookies_file = Path(args.cookies_file).expanduser()

    while True:
        try:
            print(json.dumps({"type": "status", "state": "connecting"}), flush=True)
            listen_once(args.room_id, cookies_file)
        except KeyboardInterrupt:
            return 0
        except Exception as error:
            print(f"xspace listener: {error}", file=sys.stderr, flush=True)
            print(json.dumps({"type": "status", "state": "error", "message": str(error)[:160]}), flush=True)
            time.sleep(max(0.5, args.reconnect_seconds))


if __name__ == "__main__":
    raise SystemExit(main())
