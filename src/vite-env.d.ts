/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_MODE?: string;
  readonly VITE_WORKER_BASE_URL?: string;
  readonly VITE_IMAGE_ASSET_UPLOAD_KEY?: string;
  readonly VITE_IMAGE_GENERATION_KEY?: string;
  readonly VITE_WORKOS_CLIENT_ID?: string;
  readonly VITE_WORKOS_API_HOSTNAME?: string;
}
