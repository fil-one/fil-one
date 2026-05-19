import { useSlowOperationIndicator } from '../lib/use-slow-operation-indicator.js';
import { Spinner } from './Spinner.js';

type Props = {
  isLoading: boolean;
  operation: string;
};

export function SlowOperationIndicator({ isLoading, operation }: Props) {
  const { showSpinner, showMessage } = useSlowOperationIndicator(isLoading);

  if (!showSpinner) return null;

  if (showMessage) {
    return <Spinner ariaLabel={operation} message="Hang tight — this may take a moment." />;
  }
  return <Spinner ariaLabel={operation} />;
}
