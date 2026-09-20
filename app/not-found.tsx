import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Custom 404.
 *
 * Next generates `/_not-found` by default, and a build-time failure there
 * surfaced as `Failed to collect page data for /_not-found` — a message that
 * named neither a file nor a cause. Providing the route explicitly makes it a
 * first-class page: it renders from the root layout, needs no data, and gives a
 * build-time failure an obvious owner.
 *
 * Deliberately static: no fetches, no session, no environment access.
 */
export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col justify-center pt-10">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileQuestion className="h-5 w-5 text-muted-foreground" />
            Page not found
          </CardTitle>
          <CardDescription>
            That URL does not exist in this application. It may have been renamed, or the link may be
            incomplete.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/">Go to the dashboard</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/upload">Upload suppliers</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
