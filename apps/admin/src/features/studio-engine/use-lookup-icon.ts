import { useEffect, useState } from "react";

export function useLookupIcon<Icon>(
  name: string,
  cache: ReadonlyMap<string, Icon>,
  load: (name: string) => Promise<Icon | null>,
): Icon | undefined {
  const [loaded, setLoaded] = useState<{ name: string; icon: Icon } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    load(name)
      .then((icon) => {
        if (active) setLoaded(icon === null ? null : { name, icon });
      })
      .catch(() => {
        if (active) setLoaded(null);
      });
    return () => {
      active = false;
    };
  }, [load, name]);

  return loaded?.name === name ? loaded.icon : cache.get(name);
}
