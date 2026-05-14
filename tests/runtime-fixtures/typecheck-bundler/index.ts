// Exercise every public subpath of `ai-relay` under
// `moduleResolution: "bundler"`. Used by the publish-contract test —
// `pack-contract.test.ts` installs the packed tarball into this fixture and
// runs `tsc --noEmit`. Exit 0 = subpath types resolve under bundler mode.

import { verifyBearer } from "ai-relay";
import type { AnthropicMessagesConfig, AnthropicMessagesResult } from "ai-relay/anthropic";
import { makeAnthropicMessagesHandler, registerAnthropicMessages } from "ai-relay/anthropic";
import { verifyBearer as verifyBearerSub } from "ai-relay/auth";
import { loadConfig } from "ai-relay/env";
import type { OpenAIChatConfig, OpenAIChatResult, ToolDescriptor } from "ai-relay/openai";
import { makeOpenAIChatHandler, registerOpenAIChat } from "ai-relay/openai";

const _ok: boolean = verifyBearer("a", "a") && verifyBearerSub("b", "b");

const _cfg: OpenAIChatConfig = { apiKey: "k", model: "gpt-4o-mini" };
const _handler = makeOpenAIChatHandler(_cfg);
const _register: typeof registerOpenAIChat = registerOpenAIChat;

const _acfg: AnthropicMessagesConfig = { apiKey: "k", model: "claude-sonnet-4-5" };
const _ahandler = makeAnthropicMessagesHandler(_acfg);
const _aregister: typeof registerAnthropicMessages = registerAnthropicMessages;

const _loaded = loadConfig({ env: { AI_RELAY_API_KEY: "x" } });
const _providers = _loaded.providers.length;

// Force the type imports to be retained under verbatimModuleSyntax-style
// strictness even though this isn't actually verbatim. The cast keeps the
// types referenced so the typecheck has work to do.
const _result: OpenAIChatResult | undefined = undefined;
const _aresult: AnthropicMessagesResult | undefined = undefined;
const _tool: ToolDescriptor | undefined = undefined;

export { _ahandler, _aregister, _aresult, _handler, _ok, _providers, _register, _result, _tool };
