'use client';

import { activatePolicyVersion } from '@/app/actions';
import { RowAction } from '@/components/action-form';

export function ActivateVersion({
  policyId,
  version,
  isRollback,
}: {
  policyId: string;
  version: number;
  isRollback: boolean;
}) {
  return (
    <RowAction
      action={() => activatePolicyVersion(policyId, version)}
      label={isRollback ? `Roll back to v${version}` : `Activate v${version}`}
      confirmLabel="Confirm — affects production traffic"
      variant={isRollback ? 'default' : 'primary'}
      title="Changes which policy version serves live requests."
    />
  );
}
