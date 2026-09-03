import { GridIcon } from "../icons";
import { IconButton, Menu } from "../primitives";

export function FileMenuTrigger({ onReturnToDashboard }: { onReturnToDashboard: () => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label="File menu" size="sm" variant="secondary" />}>
        <GridIcon size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" alignOffset={-4}>
          <Menu.Popup>
            <Menu.Item onClick={onReturnToDashboard}>Back to dashboard</Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
