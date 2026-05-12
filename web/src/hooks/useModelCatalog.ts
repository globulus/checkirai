import { useCallback, useEffect, useState } from "react";
import { command } from "../api";
import type { ModelCatalog } from "../types/dashboard";

export function useModelCatalog(ollamaHost: string) {
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);

  const refreshModelCatalog = useCallback(async () => {
    const out = await command("model_catalog", {
      host: ollamaHost,
      requireTooling: true,
    });
    setModelCatalog(out as ModelCatalog);
  }, [ollamaHost]);

  useEffect(() => {
    refreshModelCatalog().catch(() => {});
  }, [refreshModelCatalog]);

  return {
    modelCatalog,
    refreshModelCatalog,
  };
}
