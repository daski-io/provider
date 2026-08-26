export interface AgentCard {
  name: string;
  description: string;
  version: string;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  supportedInterfaces: Array<{
    url: string;
    protocolBinding: "HTTP+JSON";
    protocolVersion: string;
  }>;
  capabilities: {
    streaming: false;
    pushNotifications: false;
    extensions: Array<{
      uri: string;
      description: string;
      required: false;
    }>;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples: string[];
    documentationUrl: string;
  }>;
  documentationUrl: string;
  extensions: Record<string, unknown>;
}
