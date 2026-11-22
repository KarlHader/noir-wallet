import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { TabsList, TabsTrigger } from '../ui/tabs'

const pageTabClass =
  'tab-trigger-custom -mx-2 h-full min-w-0 flex-none rounded-none border-0 bg-transparent px-2 py-0 text-base font-normal text-wallet-secondary shadow-none after:max-w-11 hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:bg-transparent'

export function PageTabsList({ className, ...props }: ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      className={cn('h-10 min-w-0 justify-start gap-7 rounded-none bg-transparent p-0', className)}
      {...props}
    />
  )
}

export function PageTabsTrigger({ className, ...props }: ComponentProps<typeof TabsTrigger>) {
  return <TabsTrigger className={cn(pageTabClass, className)} {...props} />
}
