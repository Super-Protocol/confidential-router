'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@confidential-router/ui/components/avatar';
import { Button } from '@confidential-router/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@confidential-router/ui/components/dropdown-menu';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { LogOut, SlidersHorizontal, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { signOut } from '../lib/auth';
import { formatUsd } from '../lib/format';
import { useSession } from './session/session-provider';

function initialsOf(name: string | null | undefined, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return (parts[0]?.[0] ?? '?').concat(parts[1]?.[0] ?? '').toUpperCase();
}

/** The sidebar footer card from the prototype: identity, balance, sign-out. */
export function UserMenu() {
  const { viewer, activeWorkspace, loading } = useSession();
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      router.replace('/login');
    } catch (error) {
      setSigningOut(false);
      toast.error(error instanceof Error ? error.message : 'Sign-out failed.');
    }
  };

  if (loading && viewer === null) {
    return <Skeleton className="h-11 w-full" data-testid="user-menu-skeleton" />;
  }

  if (viewer === null) return null;

  const display = viewer.name?.trim() || viewer.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto w-full justify-start gap-2.5 px-2 py-1.5 hover:bg-sidebar-accent"
          aria-label={`Account: ${display}`}
        >
          <Avatar className="size-7">
            {viewer.avatarUrl ? <AvatarImage src={viewer.avatarUrl} alt="" /> : null}
            <AvatarFallback className="bg-brand text-brand-foreground text-xs">
              {initialsOf(viewer.name, viewer.email)}
            </AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-col items-start">
            <span className="max-w-full truncate text-sm">{display}</span>
            {activeWorkspace ? (
              <span className="font-mono text-muted-foreground text-xs">{formatUsd(activeWorkspace.balance)}</span>
            ) : null}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel className="truncate font-normal text-muted-foreground text-xs">
          {viewer.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/profile">
            <UserRound className="size-4" aria-hidden="true" /> Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/preferences">
            <SlidersHorizontal className="size-4" aria-hidden="true" /> Preferences
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={signingOut} onSelect={() => void handleSignOut()}>
          <LogOut className="size-4" aria-hidden="true" /> {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
