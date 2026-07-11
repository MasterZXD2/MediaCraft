import { LeftSidebar } from '@/components/layout/LeftSidebar'
import { MainArea } from '@/components/layout/MainArea'
import { RightSidebar } from '@/components/layout/RightSidebar'
import { TopBar } from '@/components/layout/TopBar'

export default function App(): JSX.Element {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <TopBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <LeftSidebar />
        <MainArea />
        <RightSidebar />
      </div>
    </div>
  )
}
