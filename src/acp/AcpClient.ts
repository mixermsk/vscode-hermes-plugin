import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk';

export type AcpClientCallbacks = Readonly<{
  onSessionUpdate: (update: SessionNotification) => void | Promise<void>;
  onPermissionRequest: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  onTransportError?: (error: Error) => void;
}>;
