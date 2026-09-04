import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { createBrowserRouter, RouterProvider, useParams } from "react-router-dom";
import { Assistant } from "./assistant";
import { AuthProvider, useAuth } from "./auth";
import { ContentPackagePage } from "./pages/content-package-page";
import { ContentReviewPage } from "./pages/content-review-page";
import { PaperComposePage } from "./pages/paper-compose";
import { TeacherLibraryPage } from "./pages/teacher-library-page";
import {
  AnnotationPage,
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
      { path: "/learning/memory/:annotationId", element: <AnnotationPage /> },
      { path: "/learning/review", element: <OwnLearningPage kind="review" /> },
      { path: "/learning/evidence/:evidenceHandle", element: <EvidencePage /> },
      { path: "/teacher/students", element: <TeacherStudentsPage /> },
      { path: "/teacher/library", element: <TeacherLibraryPage /> },
      { path: "/teacher/paper-compose", element: <PaperComposePage /> },
      { path: "/teacher/students/:studentHandle", element: <TeacherStudentPage kind="overview" /> },
      { path: "/teacher/students/:studentHandle/history", element: <TeacherStudentPage kind="history" /> },
      { path: "/teacher/students/:studentHandle/state", element: <TeacherStudentPage kind="state" /> },
      { path: "/teacher/students/:studentHandle/memory", element: <TeacherStudentPage kind="memory" /> },
      { path: "/teacher/students/:studentHandle/review", element: <TeacherStudentPage kind="review" /> },
      { path: "/teacher/students/:studentHandle/report", element: <TeacherStudentPage kind="report" /> },
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
        <AccountDataScope />
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * 登录账号切换（含登出）时清空全部 React Query 缓存。
 * 学习/自我测评的缓存 key 不含账号维度，若不清理，
 * 上一个学生账号残留的对话仍会在新账号（如教师）下显示。
 */
function AccountDataScope() {
  const { principal } = useAuth();
  const queryClient = useQueryClient();
  const previousUserId = useRef<string | null>(null);
  useEffect(() => {
    const next = principal?.uid ?? null;
    if (previousUserId.current !== null && next !== previousUserId.current) {
      queryClient.clear();
    }
    previousUserId.current = next;
  }, [principal, queryClient]);
  return null;
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
