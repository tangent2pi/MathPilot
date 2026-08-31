import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, useParams } from "react-router-dom";
import { Assistant } from "./assistant";
import { AuthProvider } from "./auth";
import { ContentPackagePage } from "./pages/content-package-page";
import { ContentReviewPage } from "./pages/content-review-page";
import {
  EvidencePage,
  LearningRecordsLayout,
  OwnLearningPage,
  TeacherStudentPage,
  TeacherStudentsPage,
} from "./learning/pages/LearningRecords";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

const router = createBrowserRouter([
  {
    path: "/",
    element: <Assistant />,
    children: [
      { index: true, element: null },
      { path: "c/:threadId", element: null },
    ],
  },
  {
    element: <LearningRecordsLayout />,
    children: [
      { path: "/learning", element: <OwnLearningPage kind="overview" /> },
      { path: "/learning/history", element: <OwnLearningPage kind="history" /> },
      { path: "/learning/state", element: <OwnLearningPage kind="state" /> },
      { path: "/learning/memory", element: <OwnLearningPage kind="memory" /> },
      { path: "/learning/review", element: <OwnLearningPage kind="review" /> },
      { path: "/learning/evidence/:evidenceHandle", element: <EvidencePage /> },
      { path: "/teacher/students", element: <TeacherStudentsPage /> },
      { path: "/teacher/students/:studentHandle", element: <TeacherStudentPage kind="overview" /> },
      { path: "/teacher/students/:studentHandle/history", element: <TeacherStudentPage kind="history" /> },
      { path: "/teacher/students/:studentHandle/state", element: <TeacherStudentPage kind="state" /> },
      { path: "/teacher/students/:studentHandle/memory", element: <TeacherStudentPage kind="memory" /> },
      { path: "/teacher/students/:studentHandle/review", element: <TeacherStudentPage kind="review" /> },
    ],
  },
  { path: "/content/review/:candidateSetId", element: <ContentReviewRoute /> },
  { path: "/content/packages/:packageId", element: <ContentPackageRoute /> },
  { path: "*", element: <NotFound /> },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}

function ContentReviewRoute() {
  const { candidateSetId = "" } = useParams();
  return <ContentReviewPage candidateSetId={candidateSetId} />;
}

function ContentPackageRoute() {
  const { packageId = "" } = useParams();
  return <ContentPackagePage packageId={packageId} />;
}

function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center p-6 text-center">
      <div>
        <h1 className="text-xl font-semibold">页面不存在</h1>
        <a className="text-muted-foreground mt-2 inline-block underline" href="/">返回数学智元</a>
      </div>
    </main>
  );
}
