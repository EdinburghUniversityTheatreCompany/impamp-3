import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "drive-picker": React.HTMLAttributes<HTMLElement> & {
        "app-id"?: string;
        "client-id"?: string;
        "developer-key"?: string;
        "oauth-token"?: string;
        "max-items"?: number;
        ref?: React.Ref<HTMLElement>;
      };
      "drive-picker-docs-view": React.HTMLAttributes<HTMLElement> & {
        "view-id"?: string;
        "include-folders"?: string;
        "mime-types"?: string;
        "owned-by-me"?: string;
      };
    }
  }
}
