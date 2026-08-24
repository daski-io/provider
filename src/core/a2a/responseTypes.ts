export interface Part {
  kind: "text" | "data" | "file";
  text?: string;
  data?: Record<string, unknown>;
  file?: { url: string; mimeType: string };
}

export interface A2AArtifact {
  artifactId: string;
  name: string;
  parts: Part[];
}

export interface A2ATask {
  id: string;
  status: {
    state: string;
    message: {
      role: "ROLE_USER" | "ROLE_AGENT";
      parts: Part[];
    };
  };
  artifacts?: A2AArtifact[];
}
