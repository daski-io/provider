export interface A2AExtensionDeclaration {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface A2AInterface {
  url: string;
  protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON";
  protocolVersion: string;
}

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
  documentationUrl: string;
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCardSupport {
  email: string;
  responseSla: string;
  emailAuthoritativeFor: string[];
  skillRequiredFor: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  supportedInterfaces: A2AInterface[];
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extensions?: A2AExtensionDeclaration[];
  };
  skills: A2ASkill[];
  documentationUrl: string;
  extensions: Record<string, unknown>;
}
