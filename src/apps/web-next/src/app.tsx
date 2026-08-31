import { Assistant } from "./assistant";
import { AuthProvider } from "./auth";
import { ContentPackagePage } from "./pages/content-package-page";
import { ContentReviewPage } from "./pages/content-review-page";

const REVIEW_PATH = /^\/content\/review\/([A-Za-z0-9_.:-]{1,160})\/?$/;
const PACKAGE_PATH = /^\/content\/packages\/([A-Za-z0-9_.:-]{1,160})\/?$/;

export function App() {
  const review = REVIEW_PATH.exec(window.location.pathname);
  const contentPackage = PACKAGE_PATH.exec(window.location.pathname);
  return (
    <AuthProvider>
      {review?.[1] ? <ContentReviewPage candidateSetId={review[1]} />
        : contentPackage?.[1] ? <ContentPackagePage packageId={contentPackage[1]} />
          : <Assistant />}
    </AuthProvider>
  );
}
