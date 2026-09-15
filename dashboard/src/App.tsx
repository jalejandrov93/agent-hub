import { CSPProvider } from "@base-ui/react/csp-provider"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { ThemeProvider } from "@/components/theme-provider"
import { SseProvider } from "@/lib/sse"
import { router } from "@/routes/tree"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

export function App() {
  return (
    <CSPProvider disableStyleElements>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <SseProvider>
            <RouterProvider router={router} />
          </SseProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </CSPProvider>
  )
}

export default App
