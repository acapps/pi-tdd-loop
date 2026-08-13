// Mock for @earendil-works/pi-coding-agent
// Provides enough surface area for the extension to register its API

import { Type as RealType } from "typebox";

// Re-export TypeBox
export const Type = RealType;

// Re-export the type-guards we need
export function isToolCallEventType(_event: any): boolean {
  return false;
}

// ---- Type definitions for ExtensionAPI (structurally compatible) ----

export interface ExtensionAPI {
  on(event: string, handler: (...args: any[]) => any): void;
  registerTool(tool: any): void;
  registerCommand(name: string, options: any): void;
  registerShortcut(_shortcut: string, _options: any): void;
  registerFlag(_name: string, _options: any): void;
  getFlag(_name: string): boolean | string | undefined;
  registerMessageRenderer<T>(_customType: string, _renderer: any): void;
  registerMarkdownTransformer(_transformer: any): void;
  registerEntryRenderer<T>(_customType: string, _renderer: any): void;
  sendMessage<T>(_message: any, _options?: any): void;
  sendUserMessage(content: string, options?: { deliverAs?: string; triggerTurn?: boolean }): void;
  appendEntry<T>(customType: string, data?: T): void;
  setSessionName(_name: string): void;
  getSessionName(): string | undefined;
  setLabel(_entryId: string, _label: string | undefined): void;
  exec(_command: string, _args: string[], _options?: any): Promise<any>;
  getActiveTools(): string[];
  getAllTools(): any[];
  setActiveTools(_toolNames: string[]): void;
  getCommands(): any[];
  setModel(_model: any): Promise<boolean>;
  getThinkingLevel(): string;
  setThinkingLevel(_level: string): void;
  registerProvider(_provider: any): void;
  unregisterProvider(_name: string): void;
  events: any;
}

// ---- Factory function for creating a mock ExtensionAPI ----

export interface MockCommandRegistration {
  name: string;
  description: string;
  handler: (...args: any[]) => any;
}

export interface MockToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: any;
  execute: (...args: any[]) => any;
}

export interface MockEventHandlerRegistration {
  event: string;
  handler: (...args: any[]) => any;
}

export interface MockMessage {
  content: string;
  options?: { deliverAs?: string; triggerTurn?: boolean };
}

export interface MockEntry {
  customType: string;
  data?: any;
}

export type MockExtensionAPI = ExtensionAPI & {
  // Captured registrations for testing
  registeredCommands: MockCommandRegistration[];
  registeredTools: MockToolRegistration[];
  eventHandlers: Map<string, ((...args: any[]) => any)[]>;
  sentMessages: MockMessage[];
  appendedEntries: MockEntry[];
  notifications: { message: string; type: string }[];
  statusUpdates: { key: string; text: string }[];
};

export function createMockExtensionAPI(): MockExtensionAPI {
  const registeredCommands: MockCommandRegistration[] = [];
  const registeredTools: MockToolRegistration[] = [];
  const eventHandlers = new Map<string, ((...args: any[]) => any)[]>();
  const sentMessages: MockMessage[] = [];
  const appendedEntries: MockEntry[] = [];
  const notifications: { message: string; type: string }[] = [];
  const statusUpdates: { key: string; text: string }[] = [];

  const api: any = {
    registeredCommands,
    registeredTools,
    eventHandlers,
    sentMessages,
    appendedEntries,
    notifications,
    statusUpdates,

    on(event: string, handler: (...args: any[]) => any): void {
      const existing = eventHandlers.get(event) || [];
      existing.push(handler);
      eventHandlers.set(event, existing);
    },

    registerTool(tool: any): void {
      registeredTools.push(tool);
    },

    registerCommand(name: string, options: any): void {
      registeredCommands.push({ name, description: options.description, handler: options.handler });
    },

    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},

    sendMessage: () => {},

    sendUserMessage(content: string, options?: any): void {
      sentMessages.push({ content, options });
    },

    appendEntry(customType: string, data?: any): void {
      appendedEntries.push({ customType, data });
    },

    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},

    exec: async (_cmd: string, _args: string[], _opts?: any) => ({ exitCode: 0, stdout: "", stderr: "" }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "none" as any,
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},

    events: {
      on: () => {},
      emit: () => {},
      once: () => {},
      off: () => {},
    },
  };

  return api;
}
